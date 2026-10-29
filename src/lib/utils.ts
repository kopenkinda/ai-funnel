export { cn } from "cn";

const quotaPriority = (label: string) =>
  label === "5h" ? 0 : label === "7d" ? 1 : 2;

export function compareQuotaLabels(a: string, b: string) {
  return quotaPriority(a) - quotaPriority(b);
}
