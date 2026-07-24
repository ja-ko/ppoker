import type { RecognitionAlternative } from "./types";
import { CTC_BLANK_INDEX, MODEL_OUTPUT_SHAPE } from "./types";

const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY;

interface BeamScores {
  blank: number;
  nonblank: number;
}

function logSumExp(...values: number[]): number {
  let maximum = NEGATIVE_INFINITY;
  for (const value of values) {
    if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) {
      throw new RangeError("CTC scores must be natural-log probabilities");
    }
    maximum = Math.max(maximum, value);
  }
  if (maximum === NEGATIVE_INFINITY) {
    return maximum;
  }
  let total = 0;
  for (const value of values) {
    total += Math.exp(value - maximum);
  }
  return maximum + Math.log(total);
}

function validateScores(
  logProbabilities: ArrayLike<number>,
  classCount: number,
): number {
  if (!Number.isInteger(classCount) || classCount < 2) {
    throw new RangeError("classCount must contain labels and a CTC blank");
  }
  if (logProbabilities.length % classCount !== 0) {
    throw new RangeError("CTC scores do not contain complete time steps");
  }
  return logProbabilities.length / classCount;
}

function scoreAt(logProbabilities: ArrayLike<number>, index: number): number {
  const score = logProbabilities[index];
  if (
    typeof score !== "number" ||
    Number.isNaN(score) ||
    score === Number.POSITIVE_INFINITY
  ) {
    throw new RangeError("CTC scores must be natural-log probabilities");
  }
  return score;
}

function compareAlternatives(
  left: RecognitionAlternative,
  right: RecognitionAlternative,
): number {
  if (left.score > right.score) return -1;
  if (left.score < right.score) return 1;
  if (left.text < right.text) return -1;
  if (left.text > right.text) return 1;
  return 0;
}

function totalScore(scores: BeamScores): number {
  return logSumExp(scores.blank, scores.nonblank);
}

function scoresFor(map: Map<string, BeamScores>, text: string): BeamScores {
  let scores = map.get(text);
  if (!scores) {
    scores = { blank: NEGATIVE_INFINITY, nonblank: NEGATIVE_INFINITY };
    map.set(text, scores);
  }
  return scores;
}

export function greedyCtcDecode(
  logProbabilities: ArrayLike<number>,
  classCount = MODEL_OUTPUT_SHAPE[2],
  blankIndex = CTC_BLANK_INDEX,
): string {
  const timeSteps = validateScores(logProbabilities, classCount);
  if (blankIndex < 0 || blankIndex >= classCount) {
    throw new RangeError("blankIndex is outside the class range");
  }

  let previous = blankIndex;
  let text = "";
  for (let time = 0; time < timeSteps; time += 1) {
    const offset = time * classCount;
    let current = 0;
    let best = scoreAt(logProbabilities, offset);
    for (let char = 1; char < classCount; char += 1) {
      const score = scoreAt(logProbabilities, offset + char);
      if (score > best) {
        current = char;
        best = score;
      }
    }
    if (current !== blankIndex && current !== previous) {
      text += String(current);
    }
    previous = current;
  }
  return text;
}

export function prefixBeamSearch(
  logProbabilities: ArrayLike<number>,
  beamWidth = 10,
  classCount = MODEL_OUTPUT_SHAPE[2],
  blankIndex = CTC_BLANK_INDEX,
): RecognitionAlternative[] {
  const timeSteps = validateScores(logProbabilities, classCount);
  if (!Number.isInteger(beamWidth) || beamWidth < 1) {
    throw new RangeError("beamWidth must be a positive integer");
  }
  if (blankIndex !== classCount - 1) {
    throw new RangeError(
      "this digit decoder requires the CTC blank to be last",
    );
  }

  let beams = new Map<string, BeamScores>([
    ["", { blank: 0, nonblank: NEGATIVE_INFINITY }],
  ]);
  for (let time = 0; time < timeSteps; time += 1) {
    const offset = time * classCount;
    const next = new Map<string, BeamScores>();
    for (const [prefix, scores] of beams) {
      const blankProbability = scoreAt(logProbabilities, offset + blankIndex);
      const unchanged = scoresFor(next, prefix);
      unchanged.blank = logSumExp(
        unchanged.blank,
        scores.blank + blankProbability,
        scores.nonblank + blankProbability,
      );

      for (let char = 0; char < blankIndex; char += 1) {
        const probability = scoreAt(logProbabilities, offset + char);
        const label = String(char);
        if (prefix.endsWith(label)) {
          unchanged.nonblank = logSumExp(
            unchanged.nonblank,
            scores.nonblank + probability,
          );
          const extended = scoresFor(next, prefix + label);
          extended.nonblank = logSumExp(
            extended.nonblank,
            scores.blank + probability,
          );
        } else {
          const extended = scoresFor(next, prefix + label);
          extended.nonblank = logSumExp(
            extended.nonblank,
            scores.blank + probability,
            scores.nonblank + probability,
          );
        }
      }
    }

    const ranked = [...next].map(([text, scores]) => ({
      text,
      score: totalScore(scores),
      scores,
    }));
    ranked.sort(compareAlternatives);
    beams = new Map(
      ranked.slice(0, beamWidth).map(({ text, scores }) => [text, scores]),
    );
  }

  const alternatives = [...beams].map(([text, scores]) => ({
    text,
    score: totalScore(scores),
  }));
  alternatives.sort(compareAlternatives);
  return alternatives;
}

export function marginConfidence(margin: number): number {
  if (Number.isNaN(margin)) {
    throw new RangeError("margin must be a number");
  }
  return 1 - Math.exp(-Math.max(margin, 0));
}
