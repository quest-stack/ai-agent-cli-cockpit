import assert from "node:assert/strict";
import test from "node:test";

import {
  TOUR_STEPS,
  advanceTour,
  createTourProgress,
  isLastTourStep,
  retreatTour,
  skipTour,
} from "../../src/renderer/tour-steps";

test("the tour advances one step at a time", () => {
  const next = advanceTour(createTourProgress());

  assert.deepEqual(next, {
    completed: false,
    stepIndex: 1,
  });
});

test("the tour moves back without passing the first step", () => {
  const movedBack = retreatTour({ completed: false, stepIndex: 2 });
  const keptAtStart = retreatTour(createTourProgress());

  assert.equal(movedBack.stepIndex, 1);
  assert.equal(movedBack.completed, false);
  assert.equal(keptAtStart.stepIndex, 0);
});

test("advancing from the final step completes the tour", () => {
  const finalStepIndex = TOUR_STEPS.length - 1;

  assert.equal(isLastTourStep(finalStepIndex), true);
  assert.deepEqual(
    advanceTour({ completed: false, stepIndex: finalStepIndex }),
    {
      completed: true,
      stepIndex: finalStepIndex,
    },
  );
});

test("skipping preserves the current step and sets the completion flag", () => {
  assert.deepEqual(skipTour({ completed: false, stepIndex: 2 }), {
    completed: true,
    stepIndex: 2,
  });
});
