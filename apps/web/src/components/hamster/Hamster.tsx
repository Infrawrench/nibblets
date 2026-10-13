import { useId, type ReactNode, type SVGProps } from "react";
import type { HamsterLook, NibbletStatus } from "@nibblet/protocol";
import {
  LINE,
  PINK,
  PINK_DEEP,
  accessoryColours,
  backgroundColours,
  bellyFill,
  eyeColours,
  furColours,
  markingFill,
} from "./palette.ts";

/**
 * A nibblet's hamster, drawn on a 100×100 grid from back to front:
 * background, ears, silhouette (body plus stuffed cheeks, outlined as one
 * shape), markings clipped to the body, belly, face, paws, accessory.
 *
 * Below 32px the whiskers, paws and fine markings are left out, since at
 * sidebar size they only add noise.
 */
export function Hamster({
  look,
  size = 40,
  status,
  className,
  title,
  decorative,
}: {
  look: HamsterLook;
  /** Hidden from assistive tech, for tiles that are already labelled. */
  decorative?: boolean;
  size?: number;
  status?: NibbletStatus | undefined;
  className?: string | undefined;
  title?: string | undefined;
}) {
  const uid = useId().replace(/:/g, "");
  const fur = furColours[look.fur];
  const detailed = size >= 32;
  const asleep = status === "stopped";
  const dizzy = status === "error";
  const statusClass = status ? `hamster-${status === "starting" ? "working" : status}` : "";

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`hamster ${statusClass} ${className ?? ""}`}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : (title ?? "Hamster")}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={`body-${uid}`}>
          <ellipse cx="50" cy="61" rx="33" ry="29" />
        </clipPath>
        <clipPath id={`bg-${uid}`}>
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>
      <Background look={look} />
      <g clipPath={look.background === "none" ? undefined : `url(#bg-${uid})`}>
        <g className="hamster-body">
          {look.accessory === "beanie" ? null : <Ears look={look} />}
          <Silhouette look={look} />
          <g clipPath={`url(#body-${uid})`}>
            <Markings look={look} detailed={detailed} />
            <ellipse cx="50" cy="84" rx="23" ry="13" fill={bellyFill(look)} />
          </g>
          <ellipse cx="50" cy="65" rx="12.5" ry="8.5" fill={bellyFill(look)} />
          {detailed ? (
            <ellipse
              cx="41"
              cy="40"
              rx="11"
              ry="5.5"
              fill="#FFFFFF"
              opacity="0.16"
              transform="rotate(-18 41 40)"
            />
          ) : null}
          <Cheeks look={look} />
          {detailed && look.whiskers ? (
            <Whiskers colour={look.fur === "black" ? "#9A918C" : fur.shade} />
          ) : null}
          <Eyes look={look} asleep={asleep} dizzy={dizzy} />
          <Nose />
          <Mouth look={look} asleep={asleep} />
          {detailed ? <Paws /> : null}
          <Accessory look={look} />
        </g>
      </g>
      {asleep ? <Zzz /> : null}
    </svg>
  );
}

function Background({ look }: { look: HamsterLook }) {
  const fill = backgroundColours[look.background];
  return fill ? <circle cx="50" cy="50" r="50" fill={fill} /> : null;
}

function Ears({ look }: { look: HamsterLook }) {
  const { base, shade } = furColours[look.fur];
  const ear = (cx: number, side: 1 | -1): ReactNode => {
    switch (look.ears) {
      case "round":
        return (
          <g key={side}>
            <circle cx={cx} cy="35" r="10" fill={base} stroke={shade} strokeWidth="2.2" />
            <circle cx={cx + side * 0.5} cy="35.5" r="5.6" fill={PINK} />
          </g>
        );
      case "tiny":
        return (
          <g key={side}>
            <circle cx={cx + side * 2} cy="37" r="6.5" fill={base} stroke={shade} strokeWidth="2" />
            <circle cx={cx + side * 2} cy="37.5" r="3.4" fill={PINK} />
          </g>
        );
      case "tall":
        return (
          <g key={side} transform={`rotate(${side * 14} ${cx} 34)`}>
            <ellipse cx={cx} cy="28" rx="8" ry="14" fill={base} stroke={shade} strokeWidth="2.2" />
            <ellipse cx={cx} cy="29" rx="4.4" ry="9" fill={PINK} />
          </g>
        );
      case "floppy":
        return (
          <g key={side} transform={`rotate(${side * 58} ${cx} 40)`}>
            <ellipse cx={cx} cy="31" rx="8" ry="12" fill={base} stroke={shade} strokeWidth="2.2" />
            <ellipse cx={cx} cy="32" rx="4.2" ry="7.5" fill={PINK} />
          </g>
        );
    }
  };
  return (
    <g>
      {ear(30, -1)}
      {ear(70, 1)}
    </g>
  );
}

/** Body and any stuffed cheeks as one outlined shape: outline pass, then fill pass. */
function Silhouette({ look }: { look: HamsterLook }) {
  const { base, shade } = furColours[look.fur];
  const stuffed = look.cheeks === "stuffed";
  const shapes = (props: { fill: string; stroke?: string; strokeWidth?: number }) => (
    <>
      <ellipse cx="50" cy="61" rx="33" ry="29" {...props} />
      {stuffed ? (
        <>
          <circle cx="24" cy="66" r="13" {...props} />
          <circle cx="76" cy="66" r="13" {...props} />
        </>
      ) : null}
    </>
  );
  return (
    <g>
      {shapes({ fill: shade, stroke: shade, strokeWidth: 4.4 })}
      {shapes({ fill: base })}
    </g>
  );
}

function Markings({ look, detailed }: { look: HamsterLook; detailed: boolean }) {
  const fill = markingFill(look);
  const belly = bellyFill(look);
  switch (look.pattern) {
    case "solid":
      return null;
    case "banded":
      return <rect x="10" y="68" width="80" height="11" fill={belly} />;
    case "patches":
      return (
        <g fill={fill} opacity="0.85">
          <ellipse cx="26" cy="48" rx="11" ry="13" />
          <ellipse cx="74" cy="76" rx="12" ry="10" />
          {detailed ? <ellipse cx="66" cy="37" rx="6" ry="5" /> : null}
        </g>
      );
    case "roan": {
      const dots: [number, number][] = [
        [30, 44],
        [38, 38],
        [62, 37],
        [71, 46],
        [26, 57],
        [76, 58],
        [34, 75],
        [67, 74],
        [45, 35],
        [56, 41],
      ];
      const shown = detailed ? dots : dots.filter((_, i) => i % 2 === 0);
      return (
        <g fill={look.fur === "white" ? furColours.grey.base : "#FFFFFF"} opacity="0.7">
          {shown.map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={detailed ? 1.7 : 2.6} />
          ))}
        </g>
      );
    }
    case "masked":
      return <ellipse cx="50" cy="45" rx="27" ry="13" fill={fill} opacity="0.75" />;
  }
}

function Cheeks({ look }: { look: HamsterLook }) {
  if (look.cheeks === "none") return null;
  const stuffed = look.cheeks === "stuffed";
  return (
    <g fill={PINK_DEEP} opacity={stuffed ? 0.38 : 0.45}>
      <ellipse cx={stuffed ? 25 : 31} cy="65" rx={stuffed ? 7.5 : 6} ry={stuffed ? 5 : 3.8} />
      <ellipse cx={stuffed ? 75 : 69} cy="65" rx={stuffed ? 7.5 : 6} ry={stuffed ? 5 : 3.8} />
    </g>
  );
}

function Whiskers({ colour }: { colour: string }) {
  return (
    <g stroke={colour} strokeWidth="0.9" strokeLinecap="round" opacity="0.75" fill="none">
      <path d="M38 63 L22 60" />
      <path d="M38 65.5 L21 66.5" />
      <path d="M62 63 L78 60" />
      <path d="M62 65.5 L79 66.5" />
    </g>
  );
}

function Eyes({ look, asleep, dizzy }: { look: HamsterLook; asleep: boolean; dizzy: boolean }) {
  const colour = eyeColours[look.eyeColour];
  const closed = (cx: number) => (
    <path
      d={`M${cx - 4.5} 54 Q${cx} 58 ${cx + 4.5} 54`}
      stroke={LINE}
      strokeWidth="2"
      strokeLinecap="round"
      fill="none"
    />
  );
  const happyClosed = (cx: number) => (
    <path
      d={`M${cx - 4.5} 55 Q${cx} 50 ${cx + 4.5} 55`}
      stroke={LINE}
      strokeWidth="2"
      strokeLinecap="round"
      fill="none"
    />
  );
  if (asleep) {
    return (
      <g>
        {closed(39)}
        {closed(61)}
      </g>
    );
  }
  if (dizzy) {
    const swirl = (cx: number) => (
      <path
        className="hamster-swirl"
        d={`M${cx} 53 m-1 0 a1 1 0 1 1 2 0 a2 2 0 1 1 -4 0 a3 3 0 1 1 6 0 a4 4 0 1 1 -8 0`}
        stroke={LINE}
        strokeWidth="1.3"
        fill="none"
      />
    );
    return (
      <g>
        {swirl(39)}
        {swirl(61)}
      </g>
    );
  }
  const open = (cx: number) => {
    switch (look.eyes) {
      case "dot":
      case "wink":
        return (
          <g className="hamster-eye">
            <circle cx={cx} cy="53" r="4.4" fill={colour} />
            <circle cx={cx + 1.4} cy="51.5" r="1.4" fill="#FFFFFF" />
          </g>
        );
      case "sparkle":
        return (
          <g className="hamster-eye">
            <circle cx={cx} cy="53" r="5.4" fill={colour} />
            <circle cx={cx + 1.8} cy="51" r="1.9" fill="#FFFFFF" />
            <circle cx={cx - 1.7} cy="55.4" r="0.95" fill="#FFFFFF" />
          </g>
        );
      case "wide":
        return (
          <g className="hamster-eye">
            <circle cx={cx} cy="53" r="6" fill="#FFFFFF" stroke={LINE} strokeWidth="1" />
            <circle cx={cx} cy="53.6" r="3.8" fill={colour} />
            <circle cx={cx + 1.2} cy="52.3" r="1.2" fill="#FFFFFF" />
          </g>
        );
      case "sleepy":
        return (
          <g className="hamster-eye">
            <circle cx={cx} cy="54" r="4" fill={colour} />
            <path
              d={`M${cx - 5.2} 52.6 L${cx + 5.2} 52.6 L${cx + 5.2} 48 L${cx - 5.2} 48 Z`}
              fill={furColours[look.fur].base}
            />
            <path
              d={`M${cx - 5} 52.6 L${cx + 5} 52.6`}
              stroke={LINE}
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </g>
        );
    }
  };
  return (
    <g>
      {open(39)}
      {look.eyes === "wink" ? happyClosed(61) : open(61)}
    </g>
  );
}

function Nose() {
  return (
    <path
      d="M47.2 59.4 Q50 57.8 52.8 59.4 Q51.4 62 50 62.2 Q48.6 62 47.2 59.4 Z"
      fill={PINK_DEEP}
    />
  );
}

function Mouth({ look, asleep }: { look: HamsterLook; asleep: boolean }) {
  const stroke: SVGProps<SVGPathElement> = {
    stroke: LINE,
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    fill: "none",
  };
  if (asleep)
    return <path className="hamster-mouth" d="M47.5 65.5 Q50 66.8 52.5 65.5" {...stroke} />;
  switch (look.mouth) {
    case "smile":
      return <path className="hamster-mouth" d="M45.5 64 Q50 68.5 54.5 64" {...stroke} />;
    case "cat":
      return (
        <path
          className="hamster-mouth"
          d="M44.5 63.6 Q47.2 67.4 50 63.8 Q52.8 67.4 55.5 63.6"
          {...stroke}
        />
      );
    case "flat":
      return <path className="hamster-mouth" d="M46.5 65.2 L53.5 65.2" {...stroke} />;
    case "open":
      return (
        <g className="hamster-mouth">
          <path
            d="M45.6 63.6 Q50 72 54.4 63.6 Z"
            fill="#7A2E2E"
            stroke={LINE}
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <rect x="47.6" y="63.4" width="2.2" height="2.6" rx="0.5" fill="#FFFFFF" />
          <rect x="50.2" y="63.4" width="2.2" height="2.6" rx="0.5" fill="#FFFFFF" />
          <ellipse cx="50" cy="67.6" rx="2.2" ry="1.3" fill={PINK_DEEP} />
        </g>
      );
    case "tongue":
      return (
        <g className="hamster-mouth">
          <ellipse
            cx="50"
            cy="67.3"
            rx="2.2"
            ry="2.6"
            fill={PINK_DEEP}
            stroke={LINE}
            strokeWidth="0.9"
          />
          <path d="M44.5 63.6 Q47.2 67.4 50 63.8 Q52.8 67.4 55.5 63.6" {...stroke} />
        </g>
      );
  }
}

function Paws() {
  return (
    <g fill={PINK} stroke={PINK_DEEP} strokeWidth="0.8">
      <ellipse cx="42.5" cy="77" rx="4.2" ry="3.2" />
      <ellipse cx="57.5" cy="77" rx="4.2" ry="3.2" />
      <ellipse cx="38" cy="89.5" rx="5" ry="3" />
      <ellipse cx="62" cy="89.5" rx="5" ry="3" />
    </g>
  );
}

function Accessory({ look }: { look: HamsterLook }) {
  const colour = accessoryColours[look.accessoryColour];
  const dark = "rgb(0 0 0 / 0.22)";
  switch (look.accessory) {
    case "none":
      return null;
    case "glasses":
      return (
        <g fill="rgb(255 255 255 / 0.18)" stroke={colour} strokeWidth="2.2">
          <circle cx="39" cy="53" r="8" />
          <circle cx="61" cy="53" r="8" />
          <path d="M47 52 Q50 50 53 52" fill="none" />
          <path d="M31 52 L21 49" fill="none" />
          <path d="M69 52 L79 49" fill="none" />
        </g>
      );
    case "party_hat":
      return (
        <g transform="rotate(-12 50 32)">
          <path
            d="M37 37 L50 6 L63 37 Z"
            fill={colour}
            stroke={dark}
            strokeWidth="1"
            strokeLinejoin="round"
          />
          <path d="M41.5 27 L58.5 27 L60.3 31.5 L39.7 31.5 Z" fill="#FFFFFF" opacity="0.8" />
          <path d="M45.4 17.5 L54.6 17.5 L56 21 L44 21 Z" fill="#FFFFFF" opacity="0.8" />
          <circle cx="50" cy="6" r="3.6" fill="#FFFFFF" />
          <path d="M37 37 Q50 40.5 63 37" stroke={dark} strokeWidth="1.4" fill="none" />
        </g>
      );
    case "bow":
      return (
        <g transform="rotate(18 70 32)" stroke={dark} strokeWidth="0.9" strokeLinejoin="round">
          <path d="M70 32 L58 25 L59 39 Z" fill={colour} />
          <path d="M70 32 L82 25 L81 39 Z" fill={colour} />
          <circle cx="70" cy="32" r="3.4" fill={colour} />
          <circle cx="68.8" cy="31" r="1" fill="#FFFFFF" stroke="none" opacity="0.7" />
        </g>
      );
    case "headphones":
      return (
        <g>
          <path
            d="M19 56 Q19 18 50 18 Q81 18 81 56"
            fill="none"
            stroke={colour}
            strokeWidth="4.4"
            strokeLinecap="round"
          />
          <path
            d="M19 56 Q19 18 50 18 Q81 18 81 56"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="1"
            opacity="0.35"
          />
          <rect
            x="11.5"
            y="47"
            width="12"
            height="18"
            rx="5"
            fill={colour}
            stroke={dark}
            strokeWidth="1"
          />
          <rect
            x="76.5"
            y="47"
            width="12"
            height="18"
            rx="5"
            fill={colour}
            stroke={dark}
            strokeWidth="1"
          />
        </g>
      );
    case "beanie":
      return (
        <g>
          <path
            d="M20 44 Q20 12 50 12 Q80 12 80 44 Z"
            fill={colour}
            stroke={dark}
            strokeWidth="1"
          />
          <path
            d="M33 16 L35 42 M50 12 L50 42 M67 16 L65 42"
            stroke={dark}
            strokeWidth="1.2"
            opacity="0.6"
          />
          <rect
            x="17"
            y="38"
            width="66"
            height="10"
            rx="5"
            fill={colour}
            stroke={dark}
            strokeWidth="1"
          />
          <rect x="17" y="38" width="66" height="10" rx="5" fill="#FFFFFF" opacity="0.18" />
          <circle cx="50" cy="10" r="6" fill="#FFFFFF" stroke={dark} strokeWidth="0.8" />
        </g>
      );
    case "crown":
      return (
        <g>
          <path
            d="M34 34 L33 16 L41.5 25 L50 12 L58.5 25 L67 16 L66 34 Z"
            fill="#F2C230"
            stroke="#B8860B"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <circle cx="50" cy="28" r="2.8" fill={colour} />
          <circle cx="40" cy="29.5" r="1.8" fill={colour} />
          <circle cx="60" cy="29.5" r="1.8" fill={colour} />
          <circle cx="33" cy="16" r="1.6" fill="#F2C230" stroke="#B8860B" strokeWidth="0.8" />
          <circle cx="50" cy="12" r="1.6" fill="#F2C230" stroke="#B8860B" strokeWidth="0.8" />
          <circle cx="67" cy="16" r="1.6" fill="#F2C230" stroke="#B8860B" strokeWidth="0.8" />
        </g>
      );
    case "scarf":
      return (
        <g stroke={dark} strokeWidth="1" strokeLinejoin="round">
          <path d="M22 70 Q50 80 78 70 L77 79 Q50 89 23 79 Z" fill={colour} />
          <path d="M62 80 L70 97 L60 98 L56 82 Z" fill={colour} />
          <path
            d="M26 74 Q50 83 74 74"
            stroke="#FFFFFF"
            strokeWidth="1.2"
            opacity="0.5"
            fill="none"
          />
        </g>
      );
  }
}

function Zzz() {
  return (
    <g
      fill="#FFFFFF"
      stroke="#4B5A75"
      strokeWidth="1.6"
      paintOrder="stroke"
      fontFamily="ui-rounded, system-ui, sans-serif"
      fontWeight="800"
    >
      <text className="hamster-z" x="70" y="32" fontSize="13">
        z
      </text>
      <text className="hamster-z" x="78" y="22" fontSize="16">
        z
      </text>
      <text className="hamster-z" x="86" y="12" fontSize="19">
        z
      </text>
    </g>
  );
}
