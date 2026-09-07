import type { Metadata } from "next";
import "./globals.css";
import { Shell, type NavCounts } from "@/components/Shell";
import { getWorkspace, one } from "@/lib/db";

export const metadata: Metadata = {
  title: "Network Waze",
  description: "Turn meeting transcripts into a relationship graph you can actually route through.",
};

export const dynamic = "force-dynamic";

/** Runs before paint so a chosen theme never flashes the wrong way. */
const THEME_INIT = `(function(){try{var t=localStorage.getItem('waze-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

async function navCounts(): Promise<NavCounts> {
  try {
    const ws = await getWorkspace();
    const row = await one<{ people: string; meetings: string; reviews: string }>(
      `SELECT
         (SELECT count(*) FROM entities WHERE workspace_id = $1 AND status <> 'merged')::text AS people,
         (SELECT count(*) FROM sources  WHERE workspace_id = $1)::text AS meetings,
         (SELECT count(*) FROM resolution_reviews WHERE workspace_id = $1 AND verdict IS NULL)::text AS reviews`,
      [ws.id],
    );
    return {
      people: Number(row?.people ?? 0),
      meetings: Number(row?.meetings ?? 0),
      reviews: Number(row?.reviews ?? 0),
    };
  } catch {
    // No database yet — the shell still renders so the setup page is reachable.
    return { people: 0, meetings: 0, reviews: 0 };
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const counts = await navCounts();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <Shell counts={counts}>{children}</Shell>
      </body>
    </html>
  );
}
