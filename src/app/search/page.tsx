import { getWorkspace, one } from "@/lib/db";
import { hasAnthropicKey } from "@/lib/anthropic";
import { SearchView } from "@/components/SearchView";
import { Setup } from "@/components/Setup";

export default async function SearchPage() {
  let selfName = "You";
  try {
    const ws = await getWorkspace();
    if (ws.self_entity_id) {
      const row = await one<{ canonical_name: string }>(
        `SELECT canonical_name FROM entities WHERE id = $1`,
        [ws.self_entity_id],
      );
      if (row) selfName = `You (${row.canonical_name})`;
    }
  } catch (err) {
    return <Setup error={(err as Error).message} />;
  }

  return (
    <div className="page">
      <header className="pageHead">
        <h1>Ask the network</h1>
        <p className="pageSub">
          Plain language in; a plan, ranked candidates, and warm routes out. Every route shows the
          people in it, how strong each link is, and what was said to establish it.
        </p>
      </header>
      <SearchView hasKey={hasAnthropicKey()} selfName={selfName} />
    </div>
  );
}
