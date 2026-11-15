export interface ObservationInputs {
  ra: string;
  dec: string;
  fov: string;
}

interface Props {
  inputs: ObservationInputs;
  setInputs: (inputs: ObservationInputs) => void;
}

export function ObservationFields({ inputs, setInputs }: Props) {
  return <>
    <label htmlFor="ra">Right ascension <span>RA</span></label>
    <input id="ra" type="number" step="any" min="0" max="359.999999999" required value={inputs.ra}
      onChange={(event) => setInputs({ ...inputs, ra: event.target.value })} />
    <label htmlFor="dec">Declination <span>DEC</span></label>
    <input id="dec" type="number" step="any" min="-90" max="90" required value={inputs.dec}
      onChange={(event) => setInputs({ ...inputs, dec: event.target.value })} />
    <label htmlFor="fov">Field of view <span>FOV</span></label>
    <input id="fov" type="number" step="any" min="0.000001" max="1" required value={inputs.fov}
      onChange={(event) => setInputs({ ...inputs, fov: event.target.value })} />
    <p className="hint">Square side length · {Number(inputs.fov) > 0 ? (Number(inputs.fov) * 60).toFixed(2) : '—'} arcmin</p>
  </>;
}
