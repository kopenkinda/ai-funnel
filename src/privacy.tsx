import { create } from "zustand";
import { persist } from "zustand/middleware";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import { ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const usePrivacy = create<{
  enabled: boolean;
  toggle: () => void;
}>()(
  persist(
    (set) => ({
      enabled: true,
      toggle: () => set((state) => ({ enabled: !state.enabled })),
    }),
    {
      name: "ai-funnel-privacy",
      partialize: (state) => ({ enabled: state.enabled }),
    },
  ),
);

export function PrivacyButton() {
  const enabled = usePrivacy((state) => state.enabled);
  const toggle = usePrivacy((state) => state.toggle);
  const label = enabled ? "Show emails" : "Hide emails";
  return (
    <Button
      variant={enabled ? "secondary" : "ghost"}
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-pressed={enabled}
      onClick={toggle}
    >
      <Icon icon={enabled ? ViewOffIcon : ViewIcon} />
    </Button>
  );
}

export function PrivateText({ children }: { children: string }) {
  const enabled = usePrivacy((state) => state.enabled);
  return children.split(/(\S*@\S*)/g).map((part, index) =>
    part.includes("@") ? (
      <span
        key={index}
        data-slot="private-email"
        aria-hidden={enabled || undefined}
        className={cn(enabled && "blur-sm select-none")}
      >
        {part}
      </span>
    ) : (
      part
    ),
  );
}
