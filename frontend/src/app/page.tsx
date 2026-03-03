const match = {
  phase: "Combat",
  round: "1 / 5",
  secondsRemaining: 9,
  totalSeconds: 15,
};

const factionHealth = [
  { label: "Red Faction", value: 72, color: "bg-rose-500" },
  { label: "Blue Faction", value: 61, color: "bg-sky-500" },
];

const player = {
  hp: 100,
  ap: 2,
  level: 2,
  xp: 24,
  xpRequiredForNextLevel: 40,
  teammatesReady: 2,
  burstCommitments: 0,
  burstRequired: 3,
};

export default function Home() {
  const timeRemainingPercent = Math.round((match.secondsRemaining / match.totalSeconds) * 100);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-5">
        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg shadow-black/20">
          <p className="text-xs uppercase tracking-widest text-slate-400">Bannerfall MVP</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Live Match</h1>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stat label="Phase" value={match.phase} />
            <Stat label="Round" value={match.round} />
          </div>

          <div className="mt-4 rounded-lg border border-slate-700 bg-slate-950/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-slate-400">⏳ Time Remaining</p>
              <p className="text-sm font-semibold">{match.secondsRemaining}s</p>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-800">
              <div className="h-2 rounded-full bg-amber-400" style={{ width: `${timeRemainingPercent}%` }} />
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
          <h2 className="text-lg font-semibold">Faction Health</h2>
          <div className="mt-4 space-y-3">
            {factionHealth.map((faction) => (
              <Bar key={faction.label} label={faction.label} value={faction.value} color={faction.color} />
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
          <h2 className="text-lg font-semibold">Player Panel</h2>
          <ul className="mt-3 space-y-2 text-sm text-slate-300">
            <li>HP: {player.hp}</li>
            <li>AP: {player.ap}</li>
            <li>Level: {player.level}</li>
            <li>EXP: {player.xp}/{player.xpRequiredForNextLevel}</li>
            <li>Teammates Ready: {player.teammatesReady}</li>
          </ul>

          <div className="mt-4 grid gap-2">
            <button className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400">
              Attack
            </button>
            <button className="rounded-md bg-amber-400 px-3 py-2 text-sm font-semibold text-amber-950 transition hover:bg-amber-300">
              Burst Commit ({player.burstCommitments}/{player.burstRequired})
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span>{label}</span>
        <span>{value}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-800">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
