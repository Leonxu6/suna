'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/features/layout/section/empty-state';
import { IconAgent, IconMessage, IconTerminal } from '@/components/ui/kortix-icons';
import { StatusDot } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { useEffect, useRef } from 'react';

import type { CallRecordEntry, LiveUtterance } from './types';

/** Only auto-scroll if the reader was already near the bottom — never yank
 *  someone who scrolled up to re-read something the agent said earlier. */
const NEAR_BOTTOM_PX = 96;

/**
 * The centerpiece of the room: the WHOLE call, not just the two voices.
 *
 * It used to render LiveKit's client-side transcription and nothing else,
 * which is why the page showed a conversation with holes in it. Everything the
 * Kortix agent put into the call, and every tool call the voice made, is
 * written server-side to `voice_call_turns` and never appears in the browser's
 * LiveKit stream at all — so it was simply absent. `entries` is that durable
 * record; `live` is the LiveKit tail, kept only for the seconds between
 * someone speaking and the server writing it down.
 *
 * The four kinds are styled apart on purpose (see `CallEntryKind`). A tool call
 * is not speech and must not look like it: no bubble, no name, a terminal glyph
 * and a monospace line instead.
 */
export function TranscriptFeed({
  entries,
  live,
  className,
}: {
  entries: CallRecordEntry[];
  live: LiveUtterance[];
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !wasNearBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [entries, live]);

  const isEmpty = entries.length === 0 && live.length === 0;

  return (
    <Card className={cn('flex min-h-0 flex-col', className)}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          Transcript
          <StatusDot tone="success" pulse />
        </CardTitle>
      </CardHeader>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          wasNearBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {isEmpty ? (
          <div className="flex h-full min-h-40 items-center justify-center">
            <EmptyState
              size="sm"
              icon={IconMessage}
              title="Waiting for the conversation to start"
              description="Everything on this call shows up here — what's said on either side, what your Kortix agent sends in, and the tools it runs."
            />
          </div>
        ) : (
          <CardContent className="space-y-3 p-0">
            {entries.map((entry) =>
              entry.kind === 'tool' ? (
                <ToolRow key={entry.cursor} entry={entry} />
              ) : (
                <SpeechRow
                  key={entry.cursor}
                  name={entry.name}
                  text={entry.text}
                  side={entry.kind === 'human' ? 'right' : 'left'}
                  tone={entry.kind}
                />
              ),
            )}
            {live.map((utterance) => (
              <SpeechRow
                key={utterance.id}
                name={utterance.name}
                text={utterance.text}
                side={utterance.isLocal ? 'right' : 'left'}
                tone={utterance.isLocal ? 'human' : 'voice'}
                pending={!utterance.final}
              />
            ))}
          </CardContent>
        )}
      </div>
    </Card>
  );
}

/** Bubble treatment per speaking kind. `kortix` gets its own so the agent's
 *  own words are never mistaken for the voice's — they are two actors, and the
 *  voice's line right after is a paraphrase of the agent's, not a repeat. */
const BUBBLE_TONE: Record<'human' | 'voice' | 'kortix', string> = {
  human: 'bg-primary/[0.06] border-primary/10',
  voice: 'bg-popover border-border',
  kortix: 'bg-kortix-base/10 border-kortix-base/30',
};

function SpeechRow({
  name,
  text,
  side,
  tone,
  pending = false,
}: {
  name: string;
  text: string;
  side: 'left' | 'right';
  tone: 'human' | 'voice' | 'kortix';
  pending?: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-1', side === 'right' ? 'items-end' : 'items-start')}>
      <span className="text-muted-foreground flex items-center gap-1 px-1 text-xs font-medium">
        {tone === 'kortix' && <IconAgent className="size-3" aria-hidden />}
        {name}
      </span>
      <div
        className={cn(
          'max-w-[85%] rounded-md border px-3 py-2 text-sm text-pretty',
          BUBBLE_TONE[tone],
          pending && 'text-muted-foreground italic',
        )}
      >
        {text || '…'}
        {pending && (
          <span
            aria-hidden
            className="bg-current ml-1 inline-block size-1.5 animate-pulse rounded-full align-middle"
          />
        )}
      </div>
    </div>
  );
}

/** Outcomes come from a fixed vocabulary (see `parseOutcome` in
 *  call-record.ts), so a failure reads as a failure at a glance rather than as
 *  one more grey chip. */
function outcomeTone(outcome: string): string {
  if (outcome === 'ok') return 'text-emerald-600 dark:text-emerald-400';
  return 'text-destructive';
}

/**
 * A tool call. Deliberately NOT a bubble and deliberately not attributed to a
 * person — nobody said this, the voice ran it. Full width, monospace, with the
 * tool's name as a label and its outcome pinned to the end.
 */
function ToolRow({ entry }: { entry: CallRecordEntry }) {
  return (
    <div className="bg-muted/40 border-border/60 flex w-full items-start gap-2 rounded-md border border-dashed px-3 py-2">
      <IconTerminal className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {entry.name}
        </div>
        <div className="text-foreground/90 mt-0.5 font-mono text-xs break-words">{entry.text}</div>
      </div>
      {entry.outcome && (
        <span className={cn('mt-0.5 shrink-0 font-mono text-[11px]', outcomeTone(entry.outcome))}>
          {entry.outcome}
        </span>
      )}
    </div>
  );
}
