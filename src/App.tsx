import { defaultGameProfiles } from "./domain/gameProfiles";

export function App() {
  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>Tachyon Prism</h1>
          <p>Core disconnected</p>
        </div>
        <button type="button">Connect Core</button>
      </section>

      <section className="dashboard-grid">
        <article className="panel latency-panel">
          <header>
            <h2>Latency</h2>
            <span>idle</span>
          </header>
          <div className="waveform" aria-label="latency waveform placeholder" />
        </article>

        <article className="panel">
          <header>
            <h2>Game Mode</h2>
            <button type="button">Add Program</button>
          </header>
          <div className="profile-list">
            {defaultGameProfiles.map((profile) => (
              <div className="profile-row" key={profile.id}>
                <div>
                  <strong>{profile.displayName}</strong>
                  <span>{profile.match.processNames.join(", ")}</span>
                </div>
                <span>{profile.udpPolicy.toUpperCase()}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <header>
            <h2>Launchers</h2>
            <button type="button">Scan Steam</button>
          </header>
          <div className="switch-row">
            <span>Steam child process tracking</span>
            <input type="checkbox" defaultChecked />
          </div>
          <div className="switch-row">
            <span>Accelerate Steam downloads</span>
            <input type="checkbox" />
          </div>
        </article>
      </section>
    </main>
  );
}
