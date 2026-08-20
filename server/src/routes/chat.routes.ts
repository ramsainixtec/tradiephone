import express from "express";
import { z } from "zod";
import type { ChatConversation, ChatMessage } from "@prisma/client";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { generateSupportReply } from "../services/chatAssistant.js";
import { supportHandoffEmail, handoffAckEmail, supportInboxAddress } from "../services/email.js";

const router = express.Router();

router.use(requireAuth);

const WELCOME_MESSAGE =
  "Hi! 👋 I'm the hello22.ai support assistant. How can I help you set up your AI receptionist?";

/** Find (or create) the user's chat conversation, with messages ordered oldest-first. */
async function getOrCreateConversation(
  userId: string,
): Promise<ChatConversation & { messages: ChatMessage[] }> {
  const existing = await prisma.chatConversation.findFirst({
    where: { userId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (existing) return existing;

  return prisma.chatConversation.create({
    data: {
      userId,
      messages: {
        create: { role: "assistant", content: WELCOME_MESSAGE },
      },
    },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { messages, ...conversation } = await getOrCreateConversation(req.user!.sub);
    res.json({ conversation, messages });
  }),
);

const postSchema = z.object({
  content: z.string().min(1),
});

router.post(
  "/messages",
  asyncHandler(async (req, res) => {
    const { content } = postSchema.parse(req.body);
    const conversation = await getOrCreateConversation(req.user!.sub);

    const userMsg = await prisma.chatMessage.create({
      data: { conversationId: conversation.id, role: "user", content },
    });

    let { reply, handoff } = await generateSupportReply(
      conversation.messages.map((m) => ({ role: m.role, content: m.content })),
      content,
      conversation.messages.length,
    );

    // The assistant signalled a handoff — actually deliver it. Only confirm to
    // the user what really happened: on a failed send, replace the "sent!"
    // reply with an honest fallback instead of silently dropping the request.
    if (handoff) {
      try {
        const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
        await supportHandoffEmail({
          accountEmail: user?.email ?? "",
          accountName: user?.fullName ?? "",
          details: handoff,
          transcript: [
            ...conversation.messages.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content },
          ],
        });
        await prisma.chatConversation.update({
          where: { id: conversation.id },
          data: { humanTakeover: true },
        });
        // Confirmation to the customer at the address they gave the assistant
        // (fallback: their account email). Best-effort — the handoff itself
        // already reached the team, so a failed ack only gets logged.
        const customerEmail = (handoff.email || user?.email || "").trim();
        if (customerEmail) {
          void handoffAckEmail({
            to: customerEmail,
            name: handoff.name || user?.fullName || "there",
            topic: handoff.topic,
            summary: handoff.summary,
          }).catch((err) => console.error("[chat] handoff ack email failed:", err));
        }
      } catch (err) {
        console.error("[chat] support handoff email failed:", err);
        reply =
          "Sorry — I couldn't reach our support team automatically just now. " +
          `Please email us directly at ${supportInboxAddress()} and we'll get back to you.`;
      }
    }

    const assistantMsg = await prisma.chatMessage.create({
      data: { conversationId: conversation.id, role: "assistant", content: reply },
    });

    res.json({ messages: [userMsg, assistantMsg] });
  }),
);

export default router;
