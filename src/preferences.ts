import { create } from "zustand";
import { persist } from "zustand/middleware";

export const usePreferences = create<{
  hour12: boolean;
  setHour12: (hour12: boolean) => void;
}>()(
  persist(
    (set) => ({
      hour12: true,
      setHour12: (hour12) => set({ hour12 }),
    }),
    {
      name: "ai-funnel-preferences",
      partialize: (state) => ({ hour12: state.hour12 }),
    },
  ),
);
