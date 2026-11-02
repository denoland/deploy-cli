import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { TRPCClient } from "../auth.ts";
import {
  describeMissingHashesFailure,
  MISSING_HASHES_LABEL,
  MissingHashesError,
  type Revision,
  waitForMissingHashes,
} from "../deploy/publish.ts";

interface Observer {
  onData: (data: unknown) => void;
  onError: (err: unknown) => void;
  onStopped: () => void;
  onComplete: () => void;
}

/** A tRPC client whose `revisions.watchUntilReady` stream the test drives. */
function fakeWatchClient() {
  const state = {
    observer: undefined as Observer | undefined,
    input: undefined as unknown,
    unsubscribed: 0,
  };
  const client = {
    subscription(path: string, input: unknown, observer: Observer) {
      assertEquals(path, "revisions.watchUntilReady");
      state.input = input;
      state.observer = observer;
      return {
        unsubscribe() {
          state.unsubscribed++;
        },
      };
    },
  } as unknown as TRPCClient;
  // The console ends the stream after a terminal snapshot: `stopped`, then
  // `complete`, as `httpSubscriptionLink` delivers it.
  const end = () => {
    state.observer!.onStopped();
    state.observer!.onComplete();
  };
  return { client, state, end };
}

const INPUT = { org: "acme", app: "web", revision: "rev-1" };
const URL = "https://console.deno.com/acme/web/builds/rev-1";

function building(labels: Record<string, string> = {}): Revision {
  return { labels, steps: [{ step: "preparing" }], status: "building" };
}

async function failure(promise: Promise<unknown>) {
  const err = await assertRejects(() => promise, MissingHashesError);
  return err.failure;
}

Deno.test("waitForMissingHashes: resolves when the label arrives", async () => {
  const { client, state } = fakeWatchClient();
  const wait = waitForMissingHashes(client, INPUT);
  assertEquals(state.input, INPUT);
  state.observer!.onData(building());
  state.observer!.onData(
    building({ [MISSING_HASHES_LABEL]: JSON.stringify(["a1", "b2"]) }),
  );
  const { missingHashes, revision } = await wait;
  assertEquals(missingHashes, ["a1", "b2"]);
  assertEquals(revision.labels[MISSING_HASHES_LABEL], '["a1","b2"]');
  assertEquals(state.unsubscribed, 1);
  // Whatever the stream does after that is ignored.
  state.observer!.onData(building());
  state.observer!.onStopped();
  state.observer!.onError(new Error("late"));
  assertEquals(state.unsubscribed, 1);
});

Deno.test("waitForMissingHashes: an empty report means nothing to upload", async () => {
  const { client, state } = fakeWatchClient();
  const wait = waitForMissingHashes(client, INPUT);
  state.observer!.onData(building({ [MISSING_HASHES_LABEL]: "[]" }));
  assertEquals((await wait).missingHashes, []);
});

Deno.test("waitForMissingHashes: a report in the first snapshot settles before subscribe returns", async () => {
  const client = {
    subscription(_path: string, _input: unknown, observer: Observer) {
      observer.onData(building({ [MISSING_HASHES_LABEL]: '["a1"]' }));
      return { unsubscribe: () => unsubscribed++ };
    },
  } as unknown as TRPCClient;
  let unsubscribed = 0;
  const { missingHashes } = await waitForMissingHashes(client, INPUT);
  assertEquals(missingHashes, ["a1"]);
  assertEquals(unsubscribed, 1);
});

Deno.test("waitForMissingHashes: rejects when the stream ends without the label", async () => {
  const { client, state, end } = fakeWatchClient();
  const wait = waitForMissingHashes(client, INPUT);
  state.observer!.onData(building());
  end();
  const f = await failure(wait);
  assertEquals(f.reason, "stream_ended");
  assertEquals(f.revision?.status, "building");
  assertEquals(state.unsubscribed, 1);
});

Deno.test("waitForMissingHashes: rejects when the stream ends before any snapshot", async () => {
  const { client, end } = fakeWatchClient();
  const wait = waitForMissingHashes(client, INPUT);
  end();
  const f = await failure(wait);
  assertEquals(f, { reason: "stream_ended", revision: undefined });
});

Deno.test("waitForMissingHashes: a failed snapshot rejects with the revision", async () => {
  const { client, state, end } = fakeWatchClient();
  const wait = waitForMissingHashes(client, INPUT);
  const failed: Revision = {
    labels: {},
    steps: [{ step: "preparing" }],
    status: "failed",
    build_failure: { kind: "process_exit", message: "git clone failed" },
  };
  state.observer!.onData(failed);
  // Rejected on the snapshot itself, not only once the stream ends.
  const f = await failure(wait);
  assertEquals(f.reason, "revision_terminal");
  assertEquals(f.revision, failed);
  assertEquals(state.unsubscribed, 1);
  end();
  assertEquals(state.unsubscribed, 1);
});

Deno.test("waitForMissingHashes: a terminal snapshot carrying the label still resolves", async () => {
  const { client, state } = fakeWatchClient();
  const wait = waitForMissingHashes(client, INPUT);
  state.observer!.onData({
    labels: { [MISSING_HASHES_LABEL]: '["a1"]' },
    steps: [{ step: "preparing" }],
    status: "failed",
  });
  assertEquals((await wait).missingHashes, ["a1"]);
});

Deno.test("waitForMissingHashes: a cancelled stream end names the revision", async () => {
  const { client, state, end } = fakeWatchClient();
  const wait = waitForMissingHashes(client, INPUT);
  state.observer!.onData({ ...building(), status: "cancelled" });
  end();
  const f = await failure(wait);
  assertEquals(f.reason, "revision_terminal");
  assertEquals(f.revision?.status, "cancelled");
});

Deno.test("waitForMissingHashes: rejects on a subscription error", async () => {
  const { client, state } = fakeWatchClient();
  const wait = waitForMissingHashes(client, INPUT);
  const cause = new Error("connection reset");
  state.observer!.onError(cause);
  const f = await failure(wait);
  assertEquals(f.reason, "subscription_error");
  assert(f.reason === "subscription_error" && f.error === cause);
  assertEquals(state.unsubscribed, 1);
});

Deno.test("waitForMissingHashes: rejects a label that is not a string array", async () => {
  for (const value of ["not json", "{}", '["a1", 2]', "null"]) {
    const { client, state } = fakeWatchClient();
    const wait = waitForMissingHashes(client, INPUT);
    state.observer!.onData(building({ [MISSING_HASHES_LABEL]: value }));
    const f = await failure(wait);
    assertEquals(f.reason, "malformed_label", value);
    assert(f.reason === "malformed_label" && f.value === value);
  }
});

Deno.test("waitForMissingHashes: rejects a snapshot without labels instead of throwing", async () => {
  for (
    const data of [{ steps: [], status: "building" }, { labels: null }, {
      labels: [],
      status: "building",
    }, null]
  ) {
    const { client, state } = fakeWatchClient();
    const wait = waitForMissingHashes(client, INPUT);
    state.observer!.onData(data);
    const f = await failure(wait);
    assertEquals(f.reason, "malformed_label");
    assertEquals(state.unsubscribed, 1);
  }
});

Deno.test("waitForMissingHashes: gives up after the timeout", async () => {
  const { client, state } = fakeWatchClient();
  const wait = waitForMissingHashes(client, INPUT, { timeoutMs: 10 });
  state.observer!.onData(building());
  const f = await failure(wait);
  assertEquals(f.reason, "timeout");
  assert(f.reason === "timeout" && f.timeoutMs === 10);
  assertEquals(f.revision?.status, "building");
  assertEquals(state.unsubscribed, 1);
  // A snapshot after the deadline is ignored.
  state.observer!.onData(building({ [MISSING_HASHES_LABEL]: "[]" }));
  assertEquals(state.unsubscribed, 1);
});

Deno.test("describeMissingHashesFailure: a failed revision reports its failure and the build URL", () => {
  const described = describeMissingHashesFailure({
    reason: "revision_terminal",
    revision: {
      labels: {},
      steps: [],
      status: "failed",
      build_failure: { kind: "process_exit", message: "git clone failed" },
    },
  }, URL);
  assertEquals(described.errorCode, "REVISION_FAILED");
  assertEquals(described.code, 1);
  assertStringIncludes(described.message, "The revision failed");
  assertStringIncludes(described.message, "git clone failed");
  assertStringIncludes(described.hint!, URL);
});

Deno.test("describeMissingHashesFailure: a cancelled revision without classification", () => {
  const described = describeMissingHashesFailure({
    reason: "revision_terminal",
    revision: { labels: {}, steps: [], status: "cancelled" },
  }, URL);
  assertEquals(described.errorCode, "REVISION_CANCELLED");
  assertEquals(
    described.message,
    "The revision was cancelled before the upload could start.",
  );
  assertStringIncludes(described.hint!, URL);
});

Deno.test("describeMissingHashesFailure: stream end, timeout and errors are actionable", () => {
  const ended = describeMissingHashesFailure(
    { reason: "stream_ended", revision: undefined },
    URL,
  );
  assertEquals(ended.errorCode, "DIFFSYNC_STREAM_ENDED");
  assertEquals(ended.code, 6);
  assertStringIncludes(ended.hint!, URL);
  assertStringIncludes(ended.hint!, "retry");

  const timedOut = describeMissingHashesFailure(
    { reason: "timeout", revision: undefined, timeoutMs: 10 * 60 * 1000 },
    URL,
  );
  assertEquals(timedOut.errorCode, "DIFFSYNC_TIMEOUT");
  assertStringIncludes(timedOut.message, "10 minutes");
  assertStringIncludes(timedOut.hint!, URL);

  const malformed = describeMissingHashesFailure(
    {
      reason: "malformed_label",
      revision: { labels: {}, steps: [], status: "building" },
      value: "{}",
    },
    URL,
  );
  assertEquals(malformed.errorCode, "DIFFSYNC_MALFORMED_RESPONSE");
  assertStringIncludes(malformed.message, "{}");

  const errored = describeMissingHashesFailure(
    {
      reason: "subscription_error",
      revision: undefined,
      error: new Error("connection reset"),
    },
    URL,
  );
  assertStringIncludes(errored.message, "connection reset");
  assertEquals(errored.errorCode, "DIFFSYNC_SUBSCRIPTION_ERROR");
  assertEquals(errored.code, 6);
  assertStringIncludes(errored.hint!, URL);
  assertStringIncludes(errored.hint!, "retry");
});
