import { useEffect, useState } from "react";
import { cn, initialsFor } from "@/lib/utils";

/** Where the avatar sits, which decides its colours. `brand` is the default
 *  (tinted tile on a normal surface); `on-primary` is for the orange hero slab,
 *  where every colour has to be a white alpha to stay on-theme. */
type Tone = "brand" | "on-primary";

const TONE: Record<Tone, string> = {
  brand: "bg-primary text-primary-foreground",
  "on-primary": "bg-white/15 text-white",
};

/**
 * The account owner's avatar: their uploaded photo when they have one, and a
 * name monogram otherwise. The monogram is the DEFAULT every account starts on —
 * it needs no upload, no storage and no request, and it re-derives itself the
 * moment the name changes. A photo that fails to load falls back to it too, so
 * this never renders a broken-image box.
 *
 * Size and text size come from `className` (e.g. "size-9 text-xs") — the caller
 * owns the layout, this owns the identity.
 */
export function UserAvatar({
  name,
  email,
  src,
  tone = "brand",
  className,
}: {
  name?: string | null;
  email?: string | null;
  /** The account's uploaded photo (profile.profileAvatarUrl). Blank → monogram. */
  src?: string | null;
  tone?: Tone;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const photo = src?.trim() ?? "";
  // A new URL deserves a fresh attempt — otherwise replacing a photo that once
  // 404'd would stay stuck on the monogram.
  useEffect(() => setBroken(false), [photo]);

  if (photo && !broken) {
    return (
      <img
        src={photo}
        alt=""
        onError={() => setBroken(true)}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold leading-none",
        TONE[tone],
        className,
      )}
    >
      {initialsFor(name, email)}
    </span>
  );
}
