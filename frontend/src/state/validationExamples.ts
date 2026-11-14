const dr1 = 'ivo://irsa.ipac/spherex_dr1?';

export const examples = [
  { id: 'arosa', name: 'Arosa', purpose: 'See a known asteroid move across the field.',
    inputs: { ra: '296.32728', dec: '-24.02440', fov: '0.20' },
    exposureIds: [
      '2026W17_1B_0003_1/D2', '2026W17_1B_0003_2/D2', '2026W17_1B_0003_3/D2', '2026W17_1B_0003_4/D2',
      '2026W17_1B_0163_1/D2', '2026W17_1B_0163_2/D2', '2026W17_1B_0163_3/D2', '2026W17_1B_0163_4/D2',
    ], pair: ['2026W17_1B_0003_1/D2', '2026W17_1B_0163_1/D2'] },
  { id: 'm101', name: 'M101 · Pinwheel Galaxy', purpose: 'Check alignment against a stationary galaxy and nearby stars.',
    inputs: { ra: '210.80227', dec: '54.34895', fov: '0.10' },
    exposureIds: ['2025W19_2B_0346_1/D2', '2025W20_2D_0176_3/D2'],
    pair: ['2025W19_2B_0346_1/D2', '2025W20_2D_0176_3/D2'] },
  { id: 'barnard', name: 'Barnard’s Star', purpose: 'Try a subtle shift of roughly one native pixel.',
    inputs: { ra: '269.4462', dec: '4.769', fov: '0.08333' },
    exposureIds: ['2025W34_2B_0090_4/D2', '2026W12_2A_0496_1/D2'],
    pair: ['2025W34_2B_0090_4/D2', '2026W12_2A_0496_1/D2'] },
].map(example => ({ ...example, exposureIds: example.exposureIds.map(id => dr1 + id), pair: example.pair.map(id => dr1 + id) }));

export const fields = [
  { name: 'Pinwheel Galaxy', reason: 'A stationary field for checking alignment.',
    inputs: { ra: '210.80227', dec: '54.34895', fov: '0.10' } },
  { name: 'WISE 0855 field', reason: 'A well-sampled field for browsing repeated infrared exposures.',
    inputs: { ra: '133.79513', dec: '-7.24515', fov: '0.05' } },
];
