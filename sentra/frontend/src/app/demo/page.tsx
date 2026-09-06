"use client";

import { TransitionLink } from "@/components/ui/Transition";
import { Icon } from "@/components/ui/Icon";
import { useDemoMode } from "@/lib/demo";
import { t } from "@/lib/i18n";

/**
 * The guided demo path (#17).
 *
 * The five steps were a thing people had to remember, in order, while talking.
 * They are written down here instead, with what each screen is for and what it
 * deliberately does not show — the restraint is half of what a school is being
 * asked to trust, and it is invisible unless someone says it out loud.
 *
 * Behind the same auth gate as every other route, so a logged-out visitor is
 * sent to /login rather than reading a tour of screens they cannot open. It
 * still handles the demo-off case, because a signed-in teacher can reach it
 * with ?demo=0 and should be told why the numbers look different rather than
 * left to guess.
 */
//: Where each step of the walk goes. Beside the page rather than in the message
//: catalogue: a second locale translates the words, never the routes.
const STEP_ROUTES = ["/", "/reflect", "/educator/roster", "/support-summary", "/audit"];
const ALSO_ROUTES = ["/chat", "/graph", "/timeline", "/guardian"];

export default function DemoPage() {
  const demo = useDemoMode();

  return (
    <div className="bl-wrap bl-stack">
      <header className="bl-stack-s">
        <span className="bl-eyebrow">{t.demo.eyebrow}</span>
        <h1 className="bl-h1">{t.demo.title}</h1>
        <p className="bl-body">{t.demo.intro}</p>
      </header>

      <section className="bl-card bl-card--tint" role="note">
        <div className="bl-card-head">
          <Icon name="visibility" size={20} />
          <h2 className="bl-h3">{demo ? t.demo.liveWarning : t.demo.notEnabled}</h2>
        </div>
        {!demo && (
          <p className="bl-meta" style={{ marginTop: 8 }}>
            {t.demo.howToEnable}
          </p>
        )}
      </section>

      <ol className="bl-stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {t.demo.steps.map((step, index) => (
          <li key={STEP_ROUTES[index]}>
            <TransitionLink href={STEP_ROUTES[index]} className="bl-card bl-card--link bl-stack-s">
              <span className="bl-eyebrow">{t.demo.stepLabel(index + 1)}</span>
              <h2 className="bl-h2">{step.title}</h2>
              <p className="bl-body">{step.body}</p>
              <p className="bl-meta">
                <Icon name="visibility" size={15} /> {step.watchFor}
              </p>
            </TransitionLink>
          </li>
        ))}
      </ol>

      <section className="bl-stack-s">
        <h2 className="bl-h2">{t.demo.alsoTitle}</h2>
        <div className="bl-grid bl-grid--2">
          {t.demo.also.map((item, index) => (
            <TransitionLink key={ALSO_ROUTES[index]} href={ALSO_ROUTES[index]} className="bl-card bl-card--link bl-stack-s">
              <h3 className="bl-h3">{item.label}</h3>
              <p className="bl-meta">{item.body}</p>
            </TransitionLink>
          ))}
        </div>
      </section>

      <section className="bl-card bl-stack-s">
        <div className="bl-card-head">
          <Icon name="info" size={20} />
          <h2 className="bl-h3">{t.demo.limitsTitle}</h2>
        </div>
        <ul className="bl-stack-s" style={{ margin: 0, paddingLeft: "1.1em" }}>
          {t.demo.limits.map((limit) => (
            <li key={limit} className="bl-body">{limit}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
