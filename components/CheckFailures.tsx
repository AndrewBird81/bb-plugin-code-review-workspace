import { createContext, memo, useContext, useEffect, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../src/rpc-contract";
import { sameLocation, type CommentLocation } from "../src/draft";
import { Icon } from "./ui/icon";

export type CheckFailure = z.infer<typeof rpcContract.getCheckFailures.output>["failures"][number];

/** CI failures at the reviewed head, which the diff shows on their new-file lines. */
export const CheckFailuresContext = createContext<CheckFailure[]>([]);

export const failureLocation = (failure: CheckFailure): CommentLocation => ({ file: failure.file, line: failure.line, side: "RIGHT" });

/** Reads a PR's CI failures once per reviewed head. */
export function useCheckFailures(targetKey: string, headSha: string | null): CheckFailure[] {
  const rpc = useRpc<typeof rpcContract>();
  const [failures, setFailures] = useState<CheckFailure[]>([]);
  useEffect(() => {
    setFailures([]);
    if (!headSha) return;
    let cancelled = false;
    rpc.call("getCheckFailures", { targetKey }).then(({ failures }) => { if (!cancelled) setFailures(failures); }).catch(() => {});
    return () => { cancelled = true; };
  }, [rpc, targetKey, headSha]);
  return failures;
}

/** A line's CI failures, each linking to its check. */
export const LineChecks = memo(function LineChecks({ at }: { at: CommentLocation }) {
  const here = useContext(CheckFailuresContext).filter((failure) => sameLocation(failureLocation(failure), at));
  if (!here.length) return null;
  return (
    <div className="mx-2 my-2 max-w-3xl space-y-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-xs leading-normal whitespace-normal text-foreground">
      {here.map((failure, index) => (
        <div key={index} role="note" aria-label={`CI failure on ${failure.file}:${failure.line}`} className="flex items-start gap-2">
          <Icon name="CircleX" className="mt-0.5 size-3.5 shrink-0 text-destructive-text" aria-hidden />
          <p className="min-w-0 flex-1 break-words">
            <span className="font-medium text-destructive-text">{failure.check}</span>
            {failure.title && <span className="font-medium"> · {failure.title}</span>}
            <span className="whitespace-pre-wrap text-muted-foreground"> {failure.message}</span>
          </p>
          <UrlLink href={failure.url} className="shrink-0 text-primary hover:underline">View check</UrlLink>
        </div>
      ))}
    </div>
  );
});
LineChecks.displayName = "LineChecks";
