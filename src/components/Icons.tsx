type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconHome = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.5V20h13V9.5" /></svg>
);
export const IconGraph = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="6" cy="7" r="2.4" /><circle cx="18" cy="6" r="2.4" /><circle cx="12" cy="18" r="2.4" /><path d="M8.2 8.2 10.4 16M16.2 7.8 13.6 16M8.3 6.6h7.3" /></svg>
);
export const IconSearch = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
);
export const IconPeople = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" /><path d="M16 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.4a5.5 5.5 0 0 1 3 5.1" /></svg>
);
export const IconMeetings = ({ size = 16 }: P) => (
  <svg {...base(size)}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" /></svg>
);
export const IconReview = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M12 3.5 4 7v5.5c0 4.2 3.2 7.4 8 8.5 4.8-1.1 8-4.3 8-8.5V7z" /><path d="m9.2 12.2 2 2 3.6-3.9" /></svg>
);
export const IconUpload = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M12 15.5V4M8.5 7.5 12 4l3.5 3.5" /><path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>
);
export const IconSun = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" /></svg>
);
export const IconMoon = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5" /></svg>
);
export const IconArrow = ({ size = 14 }: P) => (
  <svg {...base(size)}><path d="M4 12h15M13.5 6.5 20 12l-6.5 5.5" /></svg>
);
export const IconSpark = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="m12 3 1.9 5.4L19.5 10l-5.6 1.6L12 17l-1.9-5.4L4.5 10l5.6-1.6z" /><path d="M18.5 15.5 19.3 18l2.2.8-2.2.8-.8 2.4-.8-2.4-2.2-.8 2.2-.8z" /></svg>
);
export const IconLink = ({ size = 14 }: P) => (
  <svg {...base(size)}><path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3" /><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3" /></svg>
);
export const IconMenu = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const IconClose = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IconWarn = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M12 4.5 21 20H3z" /><path d="M12 10v4.5M12 17.2v.2" /></svg>
);
