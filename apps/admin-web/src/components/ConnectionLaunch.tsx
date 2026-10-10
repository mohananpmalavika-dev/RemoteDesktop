import { type FormEvent } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Monitor,
  ShieldCheck,
  Command,
  Check,
  Globe2,
  MousePointer2,
  Sparkles,
} from "lucide-react";

interface Props {
  remoteId: string;
  pin: string;
  error: string | null;
  onRemoteIdChange: (value: string) => void;
  onPinChange: (value: string) => void;
  onConnect: (event: FormEvent) => void;
}

export function ConnectionLaunch(p: Props) {
  return (
    <div className="launch-workspace">
      <section className="launch-panel">
        <div className="launch-panel-top">
          <span className="launch-icon">
            <ArrowUpRight size={23} />
          </span>
          <span className="launch-label">
            A LITTLE CLOSER. A LOT MORE POSSIBLE.
          </span>
        </div>
        <h2>
          Meet your
          <br />
          next workspace<span>.</span>
        </h2>
        <p className="launch-description">
          A familiar desktop, wherever you are.
          <br />
          Enter a Remote ID and make yourself at home.
        </p>
        <form className="launch-form" onSubmit={p.onConnect}>
          <label htmlFor="web-remote-id">
            Remote ID <span>9 digits</span>
          </label>
          <div className={`launch-input ${p.error ? "input-error" : ""}`}>
            <Monitor size={20} />
            <input
              id="web-remote-id"
              inputMode="numeric"
              autoComplete="off"
              placeholder="000 000 000"
              value={p.remoteId}
              onChange={(e) => p.onRemoteIdChange(e.target.value)}
              aria-invalid={!!p.error}
              aria-describedby={
                p.error ? "web-connect-error" : "web-connect-note"
              }
            />
          </div>
          {p.error && (
            <p className="launch-error" id="web-connect-error" role="alert">
              {p.error}
            </p>
          )}
          <button type="submit" className="launch-connect">
            Connect to device <ArrowRight size={19} />
          </button>
          <p className="launch-form-note" id="web-connect-note">
            <ShieldCheck size={14} />
            An encrypted connection. A familiar experience.
          </p>
        </form>
        <div className="launch-bottom">
          <span className="launch-mini-icon">
            <Command size={19} />
          </span>
          <p>
            No download needed.
            <br />
            <strong>Your browser is your remote workspace.</strong>
          </p>
        </div>
      </section>
      <section
        className="launch-scene"
        aria-label="Remote workspace illustration"
      >
        <div className="scene-topline">
          <span>
            <span className="scene-status-dot" /> BUILT TO BRING YOU CLOSER
          </span>
          <Globe2 size={20} />
        </div>
        <div className="scene-orbits" aria-hidden="true">
          <span />
          <span />
          <span />
          <div className="scene-dotted-line" />
        </div>
        <div className="scene-device scene-device-back" aria-hidden="true">
          <div className="scene-device-bar">
            <i />
            <i />
            <i />
            <span>YOUR DEVICE</span>
          </div>
          <div className="scene-wallpaper">
            <div className="wallpaper-orb" />
            <div className="scene-window">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
        <div className="scene-device scene-device-front" aria-hidden="true">
          <div className="scene-device-bar">
            <i />
            <i />
            <i />
            <span>YOUR WORKSPACE</span>
          </div>
          <div className="scene-wallpaper wallpaper-front">
            <div className="wallpaper-orb" />
            <span className="scene-app">
              <Command size={27} />
            </span>
            <div className="scene-dock">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
          <div className="scene-device-base" />
        </div>
        <div className="scene-floating-lock" aria-hidden="true">
          <ShieldCheck size={25} />
        </div>
        <span className="scene-floating-cursor" aria-hidden="true">
          <MousePointer2 size={23} />
          <span>You're in control</span>
        </span>
        <span className="scene-floating-tag" aria-hidden="true">
          <Check size={14} /> One connection. Endless possibilities.
        </span>
        <span className="scene-spark scene-spark-one" aria-hidden="true">
          <Sparkles size={22} />
        </span>
        <span className="scene-spark scene-spark-two" aria-hidden="true">
          +
        </span>
        <div className="scene-copy">
          <span className="scene-eyebrow">
            LESS DISTANCE. MORE POSSIBILITY.
          </span>
          <h3>
            Anywhere feels
            <br />
            like right here.
          </h3>
          <p>
            Your screen, your tools, your flow.
            <br />
            All a connection away.
          </p>
        </div>
        <div className="scene-footer">
          <span>DESIGNED AROUND YOU</span>
          <span>↗</span>
        </div>
      </section>
      <section className="launch-feature-row" aria-label="Connection features">
        <div>
          <span>
            <ShieldCheck size={21} />
          </span>
          <div>
            <h3>Private from the start</h3>
            <p>Encrypted between your devices.</p>
          </div>
        </div>
        <div>
          <span>
            <MousePointer2 size={21} />
          </span>
          <div>
            <h3>A desktop that feels familiar</h3>
            <p>Use your keyboard and mouse.</p>
          </div>
        </div>
        <div>
          <span>
            <Globe2 size={21} />
          </span>
          <div>
            <h3>Ready in your browser</h3>
            <p>Get connected without a viewer install.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
