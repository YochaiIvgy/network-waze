import { hasAnthropicKey } from "@/lib/anthropic";
import { IngestForm } from "@/components/IngestForm";

export default function IngestPage() {
  return (
    <div className="page">
      <header className="pageHead">
        <h1>Add a transcript</h1>
        <p className="pageSub">
          One meeting at a time. Re-ingesting the same note is a no-op — sources are keyed by
          content hash — so you can paste freely without worrying about duplicates.
        </p>
      </header>
      <IngestForm hasKey={hasAnthropicKey()} />
    </div>
  );
}
