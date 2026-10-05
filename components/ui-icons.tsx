import type { SVGProps } from "react";

export type IconName =
  | "lock"
  | "upload"
  | "image"
  | "sparkles"
  | "brush"
  | "eraser"
  | "undo"
  | "redo"
  | "minus"
  | "plus"
  | "hand"
  | "chevron"
  | "arrows"
  | "check"
  | "download"
  | "replace"
  | "alert"
  | "close"
  | "info"
  | "eye"
  | "eye-off"
  | "shield-check"
  | "wand"
  | "move"
  | "check-circle"
  | "mouse"
  | "sun";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, size = 18, strokeWidth = 1.8, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {name === "lock" && <><rect x="4.5" y="10" width="15" height="11" rx="2.5" /><path d="M8 10V7.2a4 4 0 0 1 8 0V10" /><path d="M12 14.2v2.7" /></>}
      {name === "upload" && <><path d="M12 15.5V3.8" /><path d="m7.5 8.3 4.5-4.5 4.5 4.5" /><path d="M4.5 14.5v3.7A2.8 2.8 0 0 0 7.3 21h9.4a2.8 2.8 0 0 0 2.8-2.8v-3.7" /></>}
      {name === "image" && <><rect x="3" y="3.5" width="18" height="17" rx="2.5" /><circle cx="8.5" cy="9" r="1.6" /><path d="m4 17 5.4-5 3.8 3.3 2.1-1.9L20 18" /></>}
      {name === "sparkles" && <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /><path d="m5 2 .6 1.7L7.3 4.3l-1.7.6L5 6.6l-.6-1.7-1.7-.6 1.7-.6L5 2Z" /></>}
      {name === "brush" && <><path d="m14.7 6.3 3-3a2.1 2.1 0 0 1 3 3l-3 3" /><path d="m4 17 10.7-10.7 3 3L7 20H4v-3Z" /><path d="M4 20c0-2.2 1.4-3.4 3.2-3.2" /></>}
      {name === "eraser" && <><path d="m7.2 4.6 12.2 12.2a2 2 0 0 1 0 2.8l-.2.2H9.8l-6-6a2.5 2.5 0 0 1 0-3.5l6-6a2.5 2.5 0 0 1 3.5 0l7.8 7.8" /><path d="m8.7 18.5 7.8-7.8" /></>}
      {name === "undo" && <><path d="M9 14 4 9l5-5" /><path d="M4 9h9a7 7 0 0 1 0 14h-2" /></>}
      {name === "redo" && <><path d="m15 14 5-5-5-5" /><path d="M20 9h-9a7 7 0 0 0 0 14h2" /></>}
      {name === "minus" && <path d="M5 12h14" />}
      {name === "plus" && <><path d="M12 5v14" /><path d="M5 12h14" /></>}
      {name === "hand" && <><path d="M8 12V5.5a1.7 1.7 0 0 1 3.4 0V11" /><path d="M11.4 10V4.4a1.7 1.7 0 0 1 3.4 0v6.2" /><path d="M14.8 10.7V6.3a1.7 1.7 0 0 1 3.4 0v8.2c0 4.1-2.5 6.5-6.2 6.5h-1.1c-2.1 0-3.7-.8-4.9-2.5l-2.4-3.4a1.8 1.8 0 0 1 2.9-2.2L8 12.6" /></>}
      {name === "chevron" && <><path d="m8 9 4 4 4-4" /><path d="m8 15 4 4 4-4" /></>}
      {name === "arrows" && <><path d="M7 8V4L3 8l4 4V8h10" /><path d="M17 16v4l4-4-4-4v4H7" /></>}
      {name === "check" && <path d="m5 12.5 4.3 4.3L19 7" />}
      {name === "download" && <><path d="M12 3.5v11" /><path d="m7.5 10 4.5 4.5 4.5-4.5" /><path d="M4.5 16v3A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" /></>}
      {name === "replace" && <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.8 9a7 7 0 0 1 11.7-2L20 9" /><path d="M18.2 15a7 7 0 0 1-11.7 2L4 15" /></>}
      {name === "alert" && <><path d="M10.3 4.4 2.6 17.7A1.5 1.5 0 0 0 3.9 20h16.2a1.5 1.5 0 0 0 1.3-2.3L13.7 4.4a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>}
      {name === "close" && <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>}
      {name === "info" && <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>}
      {name === "eye" && <><path d="M2.8 12s3.2-6 9.2-6 9.2 6 9.2 6-3.2 6-9.2 6-9.2-6-9.2-6Z" /><circle cx="12" cy="12" r="2.6" /></>}
      {name === "eye-off" && <><path d="m3 3 18 18" /><path d="M10.6 6.2A10.8 10.8 0 0 1 12 6c6 0 9.2 6 9.2 6a15.8 15.8 0 0 1-2.4 3.1" /><path d="M6.2 6.3C3.9 7.8 2.8 12 2.8 12s3.2 6 9.2 6c1.3 0 2.5-.3 3.5-.8" /><path d="M9.7 9.7a3.2 3.2 0 0 0 4.6 4.6" /></>}
      {name === "shield-check" && <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m8.5 12 2.3 2.3 4.7-4.8" /></>}
      {name === "wand" && <><path d="m15 4 5 5" /><path d="M3.8 20.2a1.8 1.8 0 0 1 0-2.5l9.9-9.9 5 5-9.9 9.9a1.8 1.8 0 0 1-2.5 0l-2.5-2.5Z" /><path d="m5 3 1 2.5L8.5 6.5 6 7.5 5 10l-1-2.5-2.5-1L4 5.5 5 3Z" /><path d="m19 15 .7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7L19 15Z" /></>}
      {name === "move" && <><path d="m8 6 4-4 4 4" /><path d="M12 2v20" /><path d="m16 18-4 4-4-4" /><path d="m6 8-4 4 4 4" /><path d="M2 12h20" /><path d="m18 16 4-4-4-4" /></>}
      {name === "check-circle" && <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.5 2.5L16.5 9" /></>}
      {name === "mouse" && <><rect x="5" y="2.5" width="14" height="19" rx="7" /><path d="M12 2.5v5" /></>}
      {name === "sun" && <><circle cx="12" cy="12" r="3.7" /><path d="M12 2v2.1M12 19.9V22M4.9 4.9l1.5 1.5m11.2 11.2 1.5 1.5M2 12h2.1m15.8 0H22M4.9 19.1l1.5-1.5M17.6 6.4l1.5-1.5" /></>}
    </svg>
  );
}
