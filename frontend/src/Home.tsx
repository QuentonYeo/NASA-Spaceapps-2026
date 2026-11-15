import type { FormEvent } from 'react';
import { ObservationFields } from './ObservationFields';
import type { ObservationInputs } from './ObservationFields';
import { examples } from './state/validationExamples';
import galaxy from './assets/m101-hubble.webp';

interface Props {
  inputs: ObservationInputs;
  setInputs: (inputs: ObservationInputs) => void;
  validation: string;
  onObserve: (event: FormEvent<HTMLFormElement>) => void;
  onValidate: (example: (typeof examples)[number]) => void;
}

export function Home({ inputs, setInputs, validation, onObserve, onValidate }: Props) {
  return <main className="home">
    <header className="home-header"><a href="#home" className="home-brand">Sifting Skies</a><span>SPHEREx infrared observation viewer</span></header>
    <section className="home-hero" style={{ backgroundImage: `linear-gradient(90deg, #0a0a0c 3%, #0a0a0ce8 31%, #0a0a0c52 76%), url(${galaxy})` }}>
      <div className="home-hero-content">
        <p className="home-kicker">SPHEREx · INFRARED SKY</p>
        <h1>See what moves.</h1>
        <p>Compare real observations of the same patch of sky at different moments.</p>
      </div>
      <a className="home-credit" href="https://science.nasa.gov/asset/hubble/hubble-image-of-m101/">M101 · Hubble / NASA, ESA and science team</a>
    </section>
    <div className="home-paths">
      <section className="home-path" aria-labelledby="home-validate">
        <h2 id="home-validate">Validate a known object</h2>
        <ul className="home-examples">
          {examples.map((example) => <li key={example.id}>
            <button type="button" onClick={() => onValidate(example)}>
              <span>
                <strong>{example.name}</strong>
                <small>{example.purpose}</small>
                <small>RA {example.inputs.ra}° · Dec {example.inputs.dec}° · FOV {example.inputs.fov}°</small>
              </span>
              <span aria-hidden="true">↗</span>
            </button>
          </li>)}
        </ul>
      </section>
      <section className="home-path" aria-labelledby="home-observation">
        <h2 id="home-observation">New observation</h2>
        <form className="home-observation-form" onSubmit={onObserve}>
          <p className="home-field-units">Enter the view parameters in degrees.</p>
          <ObservationFields inputs={inputs} setInputs={setInputs} />
          {validation && <p className="error" role="alert">{validation}</p>}
          <button className="primary" type="submit">Start <span aria-hidden="true">↗</span></button>
        </form>
      </section>
    </div>
  </main>;
}
