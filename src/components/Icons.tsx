/**
 * src/components/Icons.tsx —— 内联 SVG 图标。
 *
 * 不引图标库：这个应用用到的图标不到 20 个，一个 40KB 的图标包不值得。
 * 统一 16×16 视窗、currentColor 描边，跟着文字颜色走。
 */

import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

function Svg({ children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
);

export const Folder = (p: P) => (
  <Svg {...p}>
    <path d="M1.8 12.6V4.2c0-.5.4-.9.9-.9h3l1.3 1.6h6.3c.5 0 .9.4.9.9v6.8c0 .5-.4.9-.9.9H2.7a.9.9 0 0 1-.9-.9Z" />
  </Svg>
);

export const FolderOpen = (p: P) => (
  <Svg {...p}>
    <path d="M1.8 12.4V4.3c0-.5.4-.9.9-.9h2.9l1.3 1.6h5.4c.5 0 .9.4.9.9v1" />
    <path d="M1.8 12.4 3.4 7.6c.1-.4.5-.7.9-.7h9.3c.5 0 .9.5.8 1l-1.4 4.6c-.1.4-.5.7-.9.7H2.7a.9.9 0 0 1-.9-.8Z" />
  </Svg>
);

export const FileText = (p: P) => (
  <Svg {...p}>
    <path d="M9.2 1.8H4.4a.9.9 0 0 0-.9.9v10.6c0 .5.4.9.9.9h7.2c.5 0 .9-.4.9-.9V5.2l-3.3-3.4Z" />
    <path d="M9 1.9v3.4h3.4" />
    <path d="M5.8 9h4.4M5.8 11.2h3" />
  </Svg>
);

export const Plus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.4v9.2M3.4 8h9.2" />
  </Svg>
);

export const Trash = (p: P) => (
  <Svg {...p}>
    <path d="M2.6 3.9h10.8M6.3 3.9V2.7c0-.4.3-.7.7-.7h2c.4 0 .7.3.7.7v1.2" />
    <path d="M4.2 3.9v8.8c0 .5.4.9.9.9h5.8c.5 0 .9-.4.9-.9V3.9" />
    <path d="M6.6 6.6v4M9.4 6.6v4" />
  </Svg>
);

export const Pencil = (p: P) => (
  <Svg {...p}>
    <path d="M11.2 2.3 13.7 4.8 5.6 12.9l-3.3.8.8-3.3 8.1-8.1Z" />
  </Svg>
);

export const Gear = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2M12.5 12.5l-1.2-1.2M4.7 4.7 3.5 3.5" />
  </Svg>
);

export const Sun = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.4v1.4M8 13.2v1.4M14.6 8h-1.4M2.8 8H1.4M12.7 3.3l-1 1M4.3 11.7l-1 1M12.7 12.7l-1-1M4.3 4.3l-1-1" />
  </Svg>
);

export const Moon = (p: P) => (
  <Svg {...p}>
    <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.7 5.7 0 1 0 6.8 6.8Z" />
  </Svg>
);

export const Upload = (p: P) => (
  <Svg {...p}>
    <path d="M8 10.6V2.6" />
    <path d="M4.9 5.7 8 2.5l3.1 3.2" />
    <path d="M2.5 10.4v1.9c0 .6.5 1.1 1.1 1.1h8.8c.6 0 1.1-.5 1.1-1.1v-1.9" />
  </Svg>
);

export const Wand = (p: P) => (
  <Svg {...p}>
    <path d="M3 13 10.3 5.7" />
    <path d="M9.4 2.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3Z" />
    <path d="M13.2 7.4l.4.9.9.4-.9.4-.4.9-.4-.9-.9-.4.9-.4.4-.9Z" />
  </Svg>
);

export const Save = (p: P) => (
  <Svg {...p}>
    <path d="M3.2 2.4h7.1l2.5 2.5v8.7c0 .5-.4.9-.9.9H3.2a.9.9 0 0 1-.9-.9V3.3c0-.5.4-.9.9-.9Z" />
    <path d="M5.4 2.5v3.6h4.2V2.5" />
    <path d="M4.6 13.3V9.5h6.8v3.8" />
  </Svg>
);

export const Close = (p: P) => (
  <Svg {...p}>
    <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
  </Svg>
);

export const Refresh = (p: P) => (
  <Svg {...p}>
    <path d="M13.4 8a5.4 5.4 0 0 1-9.3 3.7L2.6 10.2" />
    <path d="M2.6 8a5.4 5.4 0 0 1 9.3-3.7l1.5 1.5" />
    <path d="M13.6 2.9v3h-3M2.4 13.1v-3h3" />
  </Svg>
);

export const Anchor = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="3.6" r="1.8" />
    <path d="M8 5.4v8.2" />
    <path d="M4.6 8.4h6.8" />
    <path d="M2.6 10.2c0 2.2 2.4 3.4 5.4 3.4s5.4-1.2 5.4-3.4" />
  </Svg>
);

/** 拆分：一刀把一页切成两页。 */
export const Split = (p: P) => (
  <Svg {...p}>
    <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
    <path d="M8 3v10" strokeDasharray="2 1.6" />
  </Svg>
);

/** 去重：两个叠在一起的文件，后面那个压着前面那个。 */
export const Dedupe = (p: P) => (
  <Svg {...p}>
    <rect x="1.8" y="2.6" width="8.4" height="9.6" rx="1.2" />
    <path d="M5.8 12.2V4.4c0-.6.5-1.1 1.1-1.1h6.3c.6 0 1.1.5 1.1 1.1v7.8c0 .6-.5 1.1-1.1 1.1H6.9a1.1 1.1 0 0 1-1.1-1.1Z" />
  </Svg>
);

export const Search = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.3" />
    <path d="M10.3 10.3 13.6 13.6" />
  </Svg>
);

export const Cards = (p: P) => (
  <Svg {...p}>
    <rect x="2.4" y="4.6" width="8" height="9" rx="1.1" />
    <path d="M5.6 4.6V3.4c0-.5.4-.9.9-.9h6.2c.5 0 .9.4.9.9v6.2c0 .5-.4.9-.9.9h-1.1" />
  </Svg>
);

export const Quiz = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M6.1 6.2c0-1 .8-1.8 1.9-1.8 1 0 1.8.7 1.8 1.7 0 1.4-1.7 1.5-1.7 3" />
    <path d="M8 11.6h.01" />
  </Svg>
);

export const Bulb = (p: P) => (
  <Svg {...p}>
    <path d="M8 1.9a4.2 4.2 0 0 1 2.6 7.5c-.4.3-.6.7-.6 1.1v.4H6v-.4c0-.4-.2-.8-.6-1.1A4.2 4.2 0 0 1 8 1.9Z" />
    <path d="M6.3 13.3h3.4" />
  </Svg>
);

export const Note = (p: P) => (
  <Svg {...p}>
    <path d="M3 3.2c0-.5.4-.9.9-.9h8.2c.5 0 .9.4.9.9v6l-3.6 3.6H3.9a.9.9 0 0 1-.9-.9V3.2Z" />
    <path d="M13 9.2H9.4v3.6" />
  </Svg>
);

/** 正文里批注/高亮的显隐开关：睁眼 = 显示，划掉的睁眼 = 已隐藏 */
export const Eye = (p: P) => (
  <Svg {...p}>
    <path d="M1.3 8S3.7 3.9 8 3.9 14.7 8 14.7 8 12.3 12.1 8 12.1 1.3 8 1.3 8Z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);

export const EyeOff = (p: P) => (
  <Svg {...p}>
    <path d="M6.4 4.1A6.7 6.7 0 0 1 8 3.9c4.3 0 6.7 4.1 6.7 4.1a12 12 0 0 1-2.1 2.6" />
    <path d="M4.1 5A11.7 11.7 0 0 0 1.3 8S3.7 12.1 8 12.1c1 0 1.9-.2 2.7-.6" />
    <path d="M2.2 2.2l11.6 11.6" />
  </Svg>
);

export const Check = (p: P) => (
  <Svg {...p}>
    <path d="M3.4 8.4l2.8 2.8 6.4-6.6" />
  </Svg>
);

export const External = (p: P) => (
  <Svg {...p}>
    <path d="M9.4 2.6h4v4" />
    <path d="M13.4 2.6 8.2 7.8" />
    <path d="M12.2 9.6v3.2c0 .5-.4.9-.9.9H3.5a.9.9 0 0 1-.9-.9V5.1c0-.5.4-.9.9-.9h3.2" />
  </Svg>
);

export const Warning = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.6 14 13H2L8 2.6Z" />
    <path d="M8 6.6v3M8 11.4h.01" />
  </Svg>
);

export const PanelLeft = (p: P) => (
  <Svg {...p}>
    <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
    <path d="M6.4 3v10" />
  </Svg>
);

export const PanelRight = (p: P) => (
  <Svg {...p}>
    <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
    <path d="M9.6 3v10" />
  </Svg>
);

/** 下载 / 导出：向下箭头落进托盘 */
export const Download = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.2v7.2" />
    <path d="M5.2 6.8 8 9.6l2.8-2.8" />
    <path d="M2.8 11.4v1.2a1.2 1.2 0 0 0 1.2 1.2h8a1.2 1.2 0 0 0 1.2-1.2v-1.2" />
  </Svg>
);

/** 返回上一级 */
export const ArrowLeft = (p: P) => (
  <Svg {...p}>
    <path d="M13 8H3.4" />
    <path d="M6.6 4.8 3.4 8l3.2 3.2" />
  </Svg>
);

/**
 * 知识地图：三个聚成一堆的点 + 一条连到别处的点。
 * 用「聚合」而不是「网状」造型——这个功能展示的是分组，不是连线。
 */
export const Graph = (p: P) => (
  <Svg {...p}>
    <circle cx="4.4" cy="4.6" r="1.7" />
    <circle cx="4.9" cy="11.4" r="1.7" />
    <circle cx="10.4" cy="7.4" r="1.7" />
    <path d="M5.6 5.9l3.3 1M6.2 10.6l2.7-2.1" />
    <path d="M12.1 7.4h1.7" />
  </Svg>
);

/** 分歧 / 说法对不上：两条方向不同的箭头顶在一起 */
export const Conflict = (p: P) => (
  <Svg {...p}>
    <path d="M2.2 5.2h6.2M6.6 3.4 8.4 5.2 6.6 7" />
    <path d="M13.8 10.8H7.6M9.4 9l-1.8 1.8L9.4 12.6" />
    <path d="M11.2 5.2h2.2M2.6 10.8h2.4" />
  </Svg>
);

/**
 * 记忆激活：卡片 + 向上的箭头。
 * 用「从笔记里升起」而不是「闪电」——闪电暗示瞬间完成，
 * 而这个任务要跑几分钟，图标不该给出错误的速度预期。
 */
export const Activate = (p: P) => (
  <Svg {...p}>
    <rect x="2.4" y="8.2" width="11.2" height="5.4" rx="1.2" />
    <path d="M8 6.4V3.2M6.2 4.6 8 2.8l1.8 1.8" />
  </Svg>
);
