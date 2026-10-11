// Typewriter reveal for the landing poem: characters appear one by one, with
// a longer pause after punctuation so the reveal breathes, and the source
// line fades in once the text is complete. Consumers pass `disabled` for
// prefers-reduced-motion (and any future no-motion mode) to show the text
// instantly; the hook is decorative and never blocks input.

import { useEffect, useState } from 'preact/hooks';

/** Per-character delay: how long to wait AFTER this character is revealed. */
export function charDelay(ch: string): number {
  // CJK punctuation ends a phrase; let the reader rest there.
  if ('，。？！；：、—…'.includes(ch)) return 280;
  if (ch === ' ' || ch === '　') return 60;
  return 85;
}

export interface TypewriterOptions {
  /** Delay before the first character (ms). */
  startDelay?: number;
  /** Skips the animation entirely and returns the full text. */
  disabled?: boolean;
}

export interface TypewriterState {
  /** The text revealed so far (the full text once done). */
  typed: string;
  /** True when the whole text is visible (immediately when disabled). */
  done: boolean;
}

export function useTypewriter(text: string | null, options: TypewriterOptions = {}): TypewriterState {
  const { startDelay = 260, disabled = false } = options;
  const [count, setCount] = useState(() => (disabled || !text ? (text?.length ?? 0) : 0));

  useEffect(() => {
    if (!text) {
      setCount(0);
      return;
    }
    if (disabled) {
      setCount(text.length);
      return;
    }
    let index = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = (): void => {
      if (cancelled) return;
      index++;
      setCount(index);
      if (index < text.length) {
        timer = setTimeout(step, charDelay(text[index - 1] ?? ''));
      }
    };
    timer = setTimeout(step, startDelay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, disabled]);

  const done = !text || count >= text.length;
  return { typed: text ? text.slice(0, count) : '', done };
}
