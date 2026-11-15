export function AppHeader({ current }: { current: 'home' | 'validate' | 'explore' }) {
  return <header className="masthead">
    <a href="#home" className="brand" aria-label="Sifting Skies home"><span className="orbit" aria-hidden="true">&#x2733;</span> Sifting Skies <span> / SPHEREx</span></a>
    <nav className="workspace-nav" aria-label="Workflows">
      {(['home', 'validate', 'explore'] as const).map(mode => <a key={mode} href={`#${mode}`}
        aria-current={current === mode ? 'page' : undefined}>{mode[0].toUpperCase() + mode.slice(1)}</a>)}
    </nav>
  </header>;
}
