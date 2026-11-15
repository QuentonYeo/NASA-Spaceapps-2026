import type { FormEvent } from 'react';
import { ObservationFields } from './ObservationFields';
import type { ObservationInputs } from './ObservationFields';
import type { ValidationExample } from './state/validationExamples';
import galaxy from './assets/m101-hubble.webp';

interface Props {
  inputs: ObservationInputs;
  setInputs: (inputs: ObservationInputs) => void;
  validation: string;
  includeQr3: boolean;
  setIncludeQr3: (include: boolean) => void;
  onObserve: (event: FormEvent<HTMLFormElement>) => void;
  knownObjects: ValidationExample[];
  onValidate: (example: ValidationExample) => void;
}

export function Home({ inputs, setInputs, validation, includeQr3, setIncludeQr3, knownObjects, onObserve, onValidate }: Props) {
  return <main className="home">
    <header className="home-header"><a href="#home" className="home-brand">Sifting Skies</a><span>SPHEREx infrared observation viewer</span></header>
    <section className="home-hero" style={{ backgroundImage: `linear-gradient(90deg, #0a0a0c 3%, #0a0a0ce8 31%, #0a0a0c52 76%), url(${galaxy})` }}>
      <div className="home-hero-content">
        <p className="home-kicker">SPHEREx · INFRARED SKY</p>
        <h1>See what moves.</h1>
        <p>Compare SPHEREx infrared images of the same patch of sky across dates. Flip between aligned images to spot motion, scan a sky field for possible moving objects, or measure how selected stars change in brightness.</p>
      </div>
      <a className="home-credit" href="https://science.nasa.gov/asset/hubble/hubble-image-of-m101/">M101 · Hubble / NASA, ESA and science team</a>
    </section>
    <div className="home-paths">
      <section className="home-path home-data" aria-labelledby="home-data">
        <div>
          <h2 id="home-data">Available SPHEREx data</h2>
          <p>Choose which spectral images to search in Explore. The viewer loads cutouts for your sky field on demand.</p>
        </div>
        <ul className="home-releases">
          <li><strong>Data Release 1 (DR1)</strong><span>Wide Survey images from Surveys 1 and 2 · included by default</span></li>
          <li><strong>Quick Release 3 (QR3)</strong><span>Newer Wide Survey images from Surveys 3 and 4 · updated as IRSA publishes them</span></li>
        </ul>
        <label className="release-option">
          <input type="checkbox" checked={includeQr3} onChange={event => setIncludeQr3(event.target.checked)} />
          Include QR3 in my next observation search
        </label>
        <a href="https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-releases/">View IRSA release notes</a>
      </section>
      <section className="home-path" aria-labelledby="home-validate">
        <h2 id="home-validate">Validate a known object</h2>
        <ul className="home-examples">
          {knownObjects.map((example) => <li key={example.id}>
            <button type="button" onClick={() => onValidate(example)}>
              <span>
                <strong>{example.name}</strong>
                <small>{example.purpose}</small>
                <small>RA {example.radiusArcsec ? Number(example.inputs.ra).toFixed(6) : example.inputs.ra}°
                  {' · '}Dec {example.radiusArcsec ? Number(example.inputs.dec).toFixed(6) : example.inputs.dec}°
                  {example.radiusArcsec ? ` · Radius ${example.radiusArcsec.toFixed(1)}″` : ` · FOV ${example.inputs.fov}°`}
                </small>
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
