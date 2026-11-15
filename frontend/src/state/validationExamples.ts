import catalog from '../../../shared/demo-examples.json';
import type { ObservationInputs } from '../ObservationFields';

interface ValidationExample {
  id: string;
  name: string;
  purpose: string;
  inputs: ObservationInputs;
  exposureIds?: string[];
  blinkIds: string[];
}

const dr1 = 'ivo://irsa.ipac/spherex_dr1?';
const examplesByField: ValidationExample[] = catalog.examples;

export const examples = examplesByField.map(example => ({
  ...example,
  exposureIds: example.exposureIds?.map(id => dr1 + id),
  blinkIds: example.blinkIds.map(id => dr1 + id),
}));

export const fields = catalog.fields;


export function preloadedValidationSequence(exampleId: string): string | undefined {
  try {
    const sequences = JSON.parse(import.meta.env.VITE_PRELOADED_VALIDATION_SEQUENCES ?? '{}');
    const id = sequences[exampleId];
    return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
