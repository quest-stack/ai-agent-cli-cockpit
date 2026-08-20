import { useLayoutEffect, useRef, useState } from "react";

import {
  TOUR_STEPS,
  advanceTour,
  createTourProgress,
  isLastTourStep,
  retreatTour,
  skipTour,
} from "../tour-steps";

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";

interface TourOverlayProps {
  onComplete: () => void;
}

interface TourRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface TourGeometry {
  card: Pick<TourRect, "left" | "top"> | null;
  spotlight: TourRect | null;
}

const CARD_GAP = 18;
const HIGHLIGHT_PADDING = 8;
const VIEWPORT_PADDING = 16;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
}

function getCardPosition(
  target: TourRect,
  card: Pick<TourRect, "height" | "width">,
): Pick<TourRect, "left" | "top"> {
  const centeredLeft = clamp(
    target.left + (target.width - card.width) / 2,
    VIEWPORT_PADDING,
    window.innerWidth - card.width - VIEWPORT_PADDING,
  );
  const centeredTop = clamp(
    target.top + (target.height - card.height) / 2,
    VIEWPORT_PADDING,
    window.innerHeight - card.height - VIEWPORT_PADDING,
  );
  const candidates = [
    {
      left: target.left + target.width + CARD_GAP,
      top: centeredTop,
    },
    {
      left: target.left - card.width - CARD_GAP,
      top: centeredTop,
    },
    {
      left: centeredLeft,
      top: target.top + target.height + CARD_GAP,
    },
    {
      left: centeredLeft,
      top: target.top - card.height - CARD_GAP,
    },
  ];
  const fitting = candidates.find(
    (candidate) =>
      candidate.left >= VIEWPORT_PADDING &&
      candidate.top >= VIEWPORT_PADDING &&
      candidate.left + card.width <= window.innerWidth - VIEWPORT_PADDING &&
      candidate.top + card.height <= window.innerHeight - VIEWPORT_PADDING,
  );

  if (fitting) {
    return fitting;
  }

  const fallback =
    target.left + target.width / 2 < window.innerWidth / 2
      ? candidates[0]
      : candidates[1];
  return {
    left: clamp(
      fallback.left,
      VIEWPORT_PADDING,
      window.innerWidth - card.width - VIEWPORT_PADDING,
    ),
    top: clamp(
      fallback.top,
      VIEWPORT_PADDING,
      window.innerHeight - card.height - VIEWPORT_PADDING,
    ),
  };
}

export function TourOverlay({ onComplete }: TourOverlayProps) {
  const [progress, setProgress] = useState(createTourProgress);
  const [geometry, setGeometry] = useState<TourGeometry>({
    card: null,
    spotlight: null,
  });
  const cardRef = useRef<HTMLElement>(null);
  const step = TOUR_STEPS[progress.stepIndex];
  const lastStep = isLastTourStep(progress.stepIndex);

  useLayoutEffect(() => {
    const updateGeometry = (): void => {
      const cardElement = cardRef.current;
      if (!step.target || !cardElement) {
        setGeometry({ card: null, spotlight: null });
        return;
      }

      const targetElement = document.querySelector<HTMLElement>(
        `[data-tour-target="${step.target}"]`,
      );
      const targetRect = targetElement?.getBoundingClientRect();
      if (
        !targetElement ||
        !targetRect ||
        targetRect.width <= 0 ||
        targetRect.height <= 0 ||
        targetRect.bottom <= 0 ||
        targetRect.right <= 0 ||
        targetRect.top >= window.innerHeight ||
        targetRect.left >= window.innerWidth
      ) {
        setGeometry({ card: null, spotlight: null });
        return;
      }

      const left = Math.max(
        HIGHLIGHT_PADDING,
        targetRect.left - HIGHLIGHT_PADDING,
      );
      const top = Math.max(
        HIGHLIGHT_PADDING,
        targetRect.top - HIGHLIGHT_PADDING,
      );
      const right = Math.min(
        window.innerWidth - HIGHLIGHT_PADDING,
        targetRect.right + HIGHLIGHT_PADDING,
      );
      const bottom = Math.min(
        window.innerHeight - HIGHLIGHT_PADDING,
        targetRect.bottom + HIGHLIGHT_PADDING,
      );
      const spotlight = {
        height: bottom - top,
        left,
        top,
        width: right - left,
      };
      const cardRect = cardElement.getBoundingClientRect();

      setGeometry({
        card: getCardPosition(spotlight, {
          height: cardRect.height,
          width: cardRect.width,
        }),
        spotlight,
      });
    };

    updateGeometry();
    cardRef.current?.querySelector<HTMLElement>(".tour-primary")?.focus();
    window.addEventListener("resize", updateGeometry);
    return () => window.removeEventListener("resize", updateGeometry);
  }, [progress.stepIndex, step.target]);

  const handleAdvance = (): void => {
    const next = advanceTour(progress);
    if (next.completed) {
      onComplete();
      return;
    }
    setProgress(next);
  };

  const handleSkip = (): void => {
    const next = skipTour(progress);
    if (next.completed) {
      onComplete();
    }
  };

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") {
      return;
    }

    const buttons = [
      ...(cardRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) {
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const cardStyle = geometry.card
    ? ({
        left: `${geometry.card.left}px`,
        top: `${geometry.card.top}px`,
      } satisfies CSSProperties)
    : undefined;
  const spotlightStyle = geometry.spotlight
    ? ({
        height: `${geometry.spotlight.height}px`,
        left: `${geometry.spotlight.left}px`,
        top: `${geometry.spotlight.top}px`,
        width: `${geometry.spotlight.width}px`,
      } satisfies CSSProperties)
    : undefined;

  return (
    <div
      className={`tour-overlay ${
        geometry.spotlight ? "has-spotlight" : "is-centered"
      }`}
      data-testid="tour-overlay"
    >
      {geometry.spotlight && (
        <div
          aria-hidden="true"
          className="tour-spotlight"
          style={spotlightStyle}
        />
      )}
      <section
        aria-describedby="tour-description"
        aria-labelledby="tour-title"
        aria-modal="true"
        className={`tour-card ${geometry.card ? "" : "is-centered"}`}
        onKeyDown={trapFocus}
        ref={cardRef}
        role="dialog"
        style={cardStyle}
      >
        <div className="tour-card-header">
          <div>
            <span className="tour-eyebrow">CLI COCKPIT TOUR</span>
            <h2 id="tour-title">{step.title}</h2>
          </div>
          <span
            aria-label={`${progress.stepIndex + 1} / ${TOUR_STEPS.length}`}
            className="tour-progress"
          >
            {progress.stepIndex + 1} / {TOUR_STEPS.length}
          </span>
        </div>

        <div aria-live="polite" className="tour-description" id="tour-description">
          {step.body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>

        <div aria-hidden="true" className="tour-step-markers">
          {TOUR_STEPS.map((tourStep, index) => (
            <span
              className={index === progress.stepIndex ? "is-active" : ""}
              key={tourStep.id}
            />
          ))}
        </div>

        <footer className="tour-actions">
          <button
            className="tour-skip"
            onClick={handleSkip}
            type="button"
          >
            スキップ
          </button>
          <div className="tour-navigation">
            <button
              className="tour-secondary"
              disabled={progress.stepIndex === 0}
              onClick={() => setProgress(retreatTour(progress))}
              type="button"
            >
              戻る
            </button>
            <button
              className="tour-primary"
              onClick={handleAdvance}
              type="button"
            >
              {lastStep ? "はじめる" : "次へ"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
