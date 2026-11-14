import galaxy from './assets/m101-hubble.webp';

export function Home() {
  return <main className="home">
    <header className="home-header"><a href="#home" className="home-brand">SPHEREx <span>SKY BLINK</span></a><span>Infrared observation viewer</span></header>
    <section className="home-hero" style={{ backgroundImage: `linear-gradient(90deg, #070a12 5%, #070a12eb 29%, #070a1240 72%), url(${galaxy})` }}>
      <div className="home-hero-content">
        <p className="home-kicker">SPHEREx · INFRARED SKY</p>
        <h1>See what moves.</h1>
        <p>Compare real observations of the same patch of sky at different moments.</p>
      </div>
      <a className="home-credit" href="https://science.nasa.gov/asset/hubble/hubble-image-of-m101/">M101 · Hubble / NASA, ESA and science team</a>
    </section>
    <nav className="home-paths" aria-label="Choose a workflow">
      <a href="#validate" className="home-path">
        <span className="home-kicker">GUIDED COMPARISON</span>
        <h2>Validate a known object</h2>
        <p>Follow Arosa’s path, check alignment on M101, or try to spot Barnard’s Star’s subtle shift.</p>
        <span className="home-action">Choose an example <span aria-hidden="true">↗</span></span>
      </a>
      <a href="#explore" className="home-path">
        <span className="home-kicker">LIVE OBSERVATIONS</span>
        <h2>Explore for movement</h2>
        <p>Enter sky coordinates or start with a suggested field. Load more observations as you need them.</p>
        <span className="home-action">Open the explorer <span aria-hidden="true">↗</span></span>
      </a>
    </nav>
  </main>;
}
