import { create } from "zustand";
import { persist } from "zustand/middleware";

export const activityColumns = {
  key: "API key",
  speed: "Speed",
  transport: "Transport",
} as const;
export type ActivityColumn = keyof typeof activityColumns;

export const usePreferences = create<{
  hour12: boolean;
  setHour12: (hour12: boolean) => void;
  columns: ActivityColumn[];
  setColumns: (columns: ActivityColumn[]) => void;
}>()(
  persist(
    (set) => ({
      hour12: true,
      setHour12: (hour12) => set({ hour12 }),
      columns: ["key", "speed"],
      setColumns: (columns) => set({ columns }),
    }),
    {
      name: "ai-funnel-preferences",
      partialize: (state) => ({ hour12: state.hour12, columns: state.columns }),
    },
  ),
);

export const useHourCycle = () =>
  usePreferences((state) => (state.hour12 ? "h12" : "h23"));
