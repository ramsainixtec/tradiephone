import { Router } from "express";
import authRouter from "./auth.routes.js";
import profileRouter from "./profile.routes.js";
import agentRouter from "./agent.routes.js";
import callsRouter from "./calls.routes.js";
import notificationsRouter from "./notifications.routes.js";
import trialRouter from "./trial.routes.js";
import crmRouter from "./crm.routes.js";
import transferRouter from "./transfer.routes.js";
import chatRouter from "./chat.routes.js";
import billingRouter from "./billing.routes.js";
import adminRouter from "./admin.routes.js";
import adminPhonesRouter from "./adminPhones.routes.js";
import apiCenterRouter from "./apiCenter.routes.js";
import resellerRouter from "./reseller.routes.js";
import onboardRouter from "./onboard.routes.js";
import bookingRouter from "./booking.routes.js";
import bookingModuleRouter from "./bookingModule.routes.js";
import bookingAiRouter from "./bookingAi.routes.js";
import aiSmsRouter from "./aiSms.routes.js";
import ttsRouter from "./tts.routes.js";
import googleRouter from "./google.routes.js";
import whatsappRouter from "./whatsapp.routes.js";
import voicesRouter from "./voices.routes.js";
import industriesRouter from "./industries.routes.js";
import eventsRouter from "./events.routes.js";
import unsubscribeRouter from "./unsubscribe.routes.js";
import { getEffective } from "../services/settings.js";
import { getBranding } from "../services/branding.js";
import { getSeoScripts } from "../services/seo.js";

export const apiRouter = Router();

// Public, non-secret runtime config for the frontend (Vapi browser key,
// branding + admin-managed custom scripts for head/body/footer).
apiRouter.get("/config", async (_req, res) => {
  res.json({
    vapiPublicKey: getEffective("vapi.publicKey"),
    branding: await getBranding(),
    scripts: await getSeoScripts(),
  });
});

apiRouter.use("/unsubscribe", unsubscribeRouter);
apiRouter.use("/events", eventsRouter);
apiRouter.use("/onboard", onboardRouter);
apiRouter.use("/bookings", bookingRouter);
// Website-first booking module. `/booking/ai` (public Vapi tool dispatcher) is
// mounted BEFORE `/booking` (owner API) so the more specific path wins. `/bookings`
// (plural, above) is the unrelated marketing demo form.
apiRouter.use("/booking/ai", bookingAiRouter);
apiRouter.use("/booking", bookingModuleRouter);
// Public Vapi tool dispatcher for "Text Info to Callers" (sendInfoSms).
apiRouter.use("/ai/sms", aiSmsRouter);
apiRouter.use("/tts", ttsRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/profile", profileRouter);
apiRouter.use("/agent", agentRouter);
apiRouter.use("/voices", voicesRouter);
apiRouter.use("/industries", industriesRouter);
apiRouter.use("/calls", callsRouter);
apiRouter.use("/notifications", notificationsRouter);
apiRouter.use("/trial", trialRouter);
apiRouter.use("/crm", crmRouter);
apiRouter.use("/transfer", transferRouter);
apiRouter.use("/google", googleRouter);
apiRouter.use("/whatsapp", whatsappRouter);
apiRouter.use("/chat", chatRouter);
apiRouter.use("/billing", billingRouter);
apiRouter.use("/admin/phones", adminPhonesRouter);
// Mounted before /admin so the more specific prefix wins.
apiRouter.use("/admin/api-center", apiCenterRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/reseller", resellerRouter);
