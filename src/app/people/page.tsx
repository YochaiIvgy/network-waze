import { getWorkspace } from "@/lib/db";
import { listEntities } from "@/lib/queries";
import { PeopleTable } from "@/components/PeopleTable";
import { Setup } from "@/components/Setup";

export default async function PeoplePage() {
  let rows;
  let selfId: string | null = null;
  try {
    const ws = await getWorkspace();
    selfId = ws.self_entity_id;
    rows = await listEntities();
  } catch (err) {
    return <Setup error={(err as Error).message} />;
  }

  return (
    <div className="page">
      <header className="pageHead">
        <h1>People &amp; organisations</h1>
        <p className="pageSub">
          Every entity resolved from your transcripts. Connectedness counts distinct typed
          relationships, not mentions — someone named forty times in one meeting is still one tie.
        </p>
      </header>
      <PeopleTable rows={rows} selfId={selfId} />
    </div>
  );
}
