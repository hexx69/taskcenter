// Northstar — full-page CEO agent chat, scoped to the selected company.
// Vector-inspired: one canonical thread per (user, company); the CEO speaks
// in first person as the company's chief. See docs/northstar-design.md.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "../components/MarkdownBody";
import { useCompany } from "../context/CompanyContext";
import {
  northstarApi,
  type NorthstarMessage,
  type NorthstarThreadSnapshot,
} from "../api/northstar";

const NORTHSTAR_QUERY_KEY = (companyId: string | null) => ["northstar", "thread", companyId] as const;

// Pending assistant bubble shape while the reply is streaming in.
type PendingBubble = { id: "__streaming__"; text: string };

export function NorthstarPage() {
  const queryClient = useQueryClient();
  const { selectedCompany, selectedCompanyId } = useCompany();

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingBubble | null>(null);
  const [inflightError, setInflightError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const {
    data: snapshot,
    isLoading,
    error,
  } = useQuery<NorthstarThreadSnapshot>({
    queryKey: NORTHSTAR_QUERY_KEY(selectedCompanyId),
    queryFn: () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return northstarApi.getThread(selectedCompanyId);
    },
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });

  // Filter out the initial "Thread created" system row — the UI doesn't need it.
  const visibleMessages = useMemo(() => {
    const rows = snapshot?.messages ?? [];
    return rows.filter((m) => m.role !== "system");
  }, [snapshot]);

  // Autoscroll to bottom on new messages or while streaming.
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleMessages.length, pending?.text]);

  // Cancel any in-flight stream when we unmount or swap companies.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, [selectedCompanyId]);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || !selectedCompanyId || pending) return;

    setDraft("");
    setInflightError(null);
    // Optimistically render the user message. We refetch the thread at the
    // end to pick up the server-persisted row + final assistant row.
    const optimisticUser: NorthstarMessage = {
      id: `local-${Date.now()}`,
      threadId: snapshot?.thread.id ?? "",
      role: "user",
      content: message,
      createdAt: Date.now(),
    };
    queryClient.setQueryData<NorthstarThreadSnapshot | undefined>(
      NORTHSTAR_QUERY_KEY(selectedCompanyId),
      (prev) =>
        prev
          ? { ...prev, messages: [...prev.messages, optimisticUser] }
          : prev,
    );
    setPending({ id: "__streaming__", text: "" });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await northstarApi.sendMessage(
        selectedCompanyId,
        message,
        {
          onDelta: (chunk) => {
            setPending((prev) =>
              prev ? { id: "__streaming__", text: prev.text + chunk } : prev,
            );
          },
          onDone: () => {
            // Settle — the server has the real row now.
            setPending(null);
            void queryClient.invalidateQueries({
              queryKey: NORTHSTAR_QUERY_KEY(selectedCompanyId),
            });
          },
          onError: (msg) => {
            setInflightError(msg);
          },
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setInflightError(err instanceof Error ? err.message : "Stream failed");
    } finally {
      abortRef.current = null;
      setPending(null);
    }
  }, [draft, pending, queryClient, selectedCompanyId, snapshot?.thread.id]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  if (!selectedCompanyId) {
    return (
      <EmptyState
        title="Pick a company"
        body="Northstar talks to the CEO of the company you have selected in the sidebar."
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="flex flex-col">
          <span className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            Northstar
          </span>
          <span className="text-sm font-semibold text-foreground">
            {selectedCompany?.name ? `CEO · ${selectedCompany.name}` : "CEO"}
          </span>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading your thread…
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to load thread."}
            </div>
          ) : visibleMessages.length === 0 && !pending ? (
            <OpeningLine companyName={selectedCompany?.name ?? "your company"} />
          ) : null}

          {visibleMessages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {pending ? (
            <MessageBubble
              message={{
                id: pending.id,
                threadId: snapshot?.thread.id ?? "",
                role: "assistant",
                content: pending.text || "…",
                createdAt: Date.now(),
              }}
              streaming
            />
          ) : null}

          {inflightError ? (
            <p className="text-xs text-destructive">{inflightError}</p>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border bg-background/70 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Ask ${selectedCompany?.name ? `${selectedCompany.name}'s CEO` : "your CEO"} anything…`}
            className="min-h-[64px] resize-none"
            disabled={Boolean(pending)}
          />
          <Button
            type="button"
            size="icon"
            disabled={!draft.trim() || Boolean(pending)}
            onClick={() => void send()}
            aria-label="Send"
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  streaming,
}: {
  message: NorthstarMessage;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  const isAgentReport = !isUser && message.content.startsWith("[Agent Report");

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
          isUser
            ? "bg-primary text-primary-foreground"
            : isAgentReport
              ? "border border-dashed border-border bg-muted/40 text-foreground"
              : "bg-muted text-foreground"
        }`}
      >
        {isAgentReport ? (
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Sub-agent report
          </p>
        ) : null}
        <MarkdownBody softBreaks>{message.content}</MarkdownBody>
        {streaming ? (
          <span className="ml-1 inline-block h-3 w-2 animate-pulse bg-current align-middle opacity-60" />
        ) : null}
      </div>
    </div>
  );
}

function OpeningLine({ companyName }: { companyName: string }) {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.2em] text-foreground">
        New conversation
      </p>
      <p>
        You&rsquo;re talking to the CEO of <strong>{companyName}</strong>. They know
        your projects, agents, and open approvals. Ask what to prioritize, who should
        own a task, or tell them to spin up work.
      </p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <Sparkles className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <h2 className="mb-1 text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

export default NorthstarPage;
