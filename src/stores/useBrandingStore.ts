import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, type Branding } from "@/lib/api";

interface BrandingState {
  assets: Branding;
  loaded: boolean;
  refresh: () => Promise<void>;
}

const EMPTY: Branding = {
  logoLight: "",
  logoDark: "",
  favicon: "",
  avatarFemale: "",
  avatarMale: "",
};

/** Point a <link rel> at the given href, creating the tag if it's missing. */
function setIconLink(rel: string, url: string) {
  let link = document.querySelector<HTMLLinkElement>(`link[rel~="${rel}"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  link.href = url;
}

/** Swap the document favicon + iOS home-screen icon to the configured asset. */
function applyFavicon(url: string) {
  if (typeof document === "undefined" || !url) return;
  setIconLink("icon", url);
  setIconLink("apple-touch-icon", url);
}

export const useBrandingStore = create<BrandingState>()(
  persist(
    (set) => ({
      assets: EMPTY,
      loaded: false,
      refresh: async () => {
        try {
          const cfg = await api.config();
          const assets = cfg.branding ?? EMPTY;
          set({ assets, loaded: true });
          applyFavicon(assets.favicon);
        } catch {
          set({ loaded: true });
        }
      },
    }),
    {
      name: "tradiephone_branding",
      onRehydrateStorage: () => (state) => {
        if (state?.assets.favicon) applyFavicon(state.assets.favicon);
      },
    },
  ),
);
