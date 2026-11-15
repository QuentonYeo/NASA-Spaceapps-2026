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
const vestaExposures = ['2025W32_1A_0105_1/D6', '2025W32_1A_0225_1/D6', '2025W32_1A_0347_1/D6'];

const examplesByField: ValidationExample[] = [
  { id: 'vesta', name: 'Vesta', purpose: 'Follow a bright asteroid through three positions over 26 hours.',
    inputs: { ra: '223.024527', dec: '-11.992267', fov: '0.42' },
    exposureIds: vestaExposures, blinkIds: vestaExposures },
  { id: 'arosa', name: 'Arosa', purpose: 'See a known asteroid move across the field.',
    inputs: { ra: '296.32728', dec: '-24.02440', fov: '0.20' },
    exposureIds: [
      '2026W17_1B_0003_1/D2', '2026W17_1B_0003_2/D2', '2026W17_1B_0003_3/D2', '2026W17_1B_0003_4/D2',
      '2026W17_1B_0163_1/D2', '2026W17_1B_0163_2/D2', '2026W17_1B_0163_3/D2', '2026W17_1B_0163_4/D2',
    ], blinkIds: ['2026W17_1B_0003_1/D2', '2026W17_1B_0163_1/D2'] },
  { id: 'm101', name: 'M101 · Pinwheel Galaxy', purpose: 'Check alignment against a stationary galaxy and nearby stars.',
    inputs: { ra: '210.80227', dec: '54.34895', fov: '0.10' },
    exposureIds: ['2025W19_2B_0346_1/D2', '2025W20_2D_0176_3/D2'],
    blinkIds: ['2025W19_2B_0346_1/D2', '2025W20_2D_0176_3/D2'] },
  { id: 'barnard', name: 'Barnard’s Star', purpose: 'Try a subtle shift of roughly one native pixel.',
    inputs: { ra: '269.4462', dec: '4.769', fov: '0.08333' },
    exposureIds: ['2025W34_2B_0090_4/D2', '2026W12_2A_0496_1/D2'],
    blinkIds: ['2025W34_2B_0090_4/D2', '2026W12_2A_0496_1/D2'] },
  { id: 'epsilon-indi-b', name: 'Epsilon Indi B', purpose: 'Compare the unresolved brown-dwarf pair across widely spaced dates.',
    inputs: { ra: '331.117', dec: '-56.808', fov: '0.08' }, blinkIds: [] },
  { id: 'wise-0855', name: 'WISE 0855−0714', purpose: 'Inspect the field of a fast-moving, faint brown dwarf across widely spaced dates.',
    inputs: { ra: '133.795129', dec: '-7.245147', fov: '0.12' }, blinkIds: [] },
  { id: 'rw-aur', name: 'RW Aurigae', purpose: 'Compare brightness at the same position and similar wavelengths.',
    inputs: { ra: '76.956542', dec: '30.401417', fov: '0.06' }, blinkIds: [] },
  { id: 'r-dra', name: 'R Draconis', purpose: 'Compare brightness at the same position and similar wavelengths.',
    inputs: { ra: '248.167611', dec: '66.754979', fov: '0.06' }, blinkIds: [] },
];

export const examples = examplesByField.map(example => ({
  ...example,
  exposureIds: example.exposureIds?.map(id => dr1 + id),
  blinkIds: example.blinkIds.map(id => dr1 + id),
}));

export const fields = [
  { name: 'Pinwheel Galaxy', reason: 'A stationary field for checking alignment.',
    inputs: { ra: '210.80227', dec: '54.34895', fov: '0.10' } },
  { name: 'WISE 0855 field', reason: 'A well-sampled field for browsing repeated infrared exposures.',
    inputs: { ra: '133.79513', dec: '-7.24515', fov: '0.05' } },
];


export function preloadedValidationSequence(exampleId: string): string | undefined {
  try {
    const sequences = JSON.parse(import.meta.env.VITE_PRELOADED_VALIDATION_SEQUENCES ?? '{}');
    const id = sequences[exampleId];
    return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
