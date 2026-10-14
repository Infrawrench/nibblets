import type { ReactNode } from "react";
import type { CityBackground } from "@nibblet/protocol";

/**
 * Skylines for behind a hamster, drawn in its 100 × 100 frame. The hamster
 * covers the middle (roughly x 18 to 82 below y 25), so each city puts its
 * landmarks at the sides and above the head, where they peek out.
 * `detailed` is false at small sizes, where windows and cables are noise.
 */
export interface CityScene {
  label: string;
  /** Sky, top to bottom. */
  sky: readonly [string, string];
  draw(detailed: boolean): ReactNode;
}

const windows = (
  xs: readonly number[],
  ys: readonly number[],
  fill: string,
  skip: (x: number, y: number) => boolean = () => false,
) =>
  xs.flatMap((x) =>
    ys
      .filter((y) => !skip(x, y))
      .map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="1.4" height="1.8" fill={fill} />),
  );

export const cities: Record<CityBackground, CityScene> = {
  london: {
    label: "London",
    sky: ["#93ADCB", "#EBD9C6"],
    draw: (detailed) => (
      <>
        {/* The London Eye, over the head. */}
        <g stroke="#7A8CA6" strokeWidth="0.7" fill="none">
          <circle cx="66" cy="24" r="14" />
          {detailed
            ? Array.from({ length: 8 }, (_, i) => {
                const a = (i * Math.PI) / 8;
                return (
                  <line
                    key={i}
                    x1={66 - 14 * Math.cos(a)}
                    y1={24 - 14 * Math.sin(a)}
                    x2={66 + 14 * Math.cos(a)}
                    y2={24 + 14 * Math.sin(a)}
                    strokeWidth="0.35"
                  />
                );
              })
            : null}
        </g>
        {/* Rooftops along the river. */}
        <path d="M0 74 H22 V68 H30 V100 H0Z M72 100 V70 H80 V64 H100 V100Z" fill="#8C97A8" />
        {/* Elizabeth Tower (Big Ben). */}
        <path d="M6 100 V40 L7.5 37 V33 L10.5 26 L13.5 33 V37 L15 40 V100Z" fill="#6F6A62" />
        <circle cx="10.5" cy="42.5" r="2.4" fill="#F3E3B8" stroke="#5B564F" strokeWidth="0.5" />
        {/* The Shard. */}
        <path d="M84 100 L88.5 22 L90 19 L91 23 L96 100Z" fill="#7C8C9F" />
        {detailed ? (
          <path d="M90 23 L92.6 100" stroke="#A9B8C8" strokeWidth="0.5" fill="none" />
        ) : null}
      </>
    ),
  },

  new_york: {
    label: "New York",
    sky: ["#1E2A4F", "#4A5C8E"],
    draw: (detailed) => (
      <>
        <circle cx="70" cy="16" r="5" fill="#F4EFD7" />
        <circle cx="72" cy="14.5" r="4.4" fill="#1F2B50" />
        {detailed
          ? [
              [22, 10],
              [34, 18],
              [48, 8],
              [58, 20],
              [84, 12],
              [12, 26],
            ].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="0.5" fill="#F4EFD7" />)
          : null}
        {/* Blocks behind. */}
        <path
          d="M0 100 V60 H6 V54 H18 V64 H24 V100Z M76 100 V58 H82 V50 H88 V62 H100 V100Z"
          fill="#36436F"
        />
        {/* The Empire State Building. */}
        <path
          d="M5 100 V46 H7 V40 H9 V34 H10.4 V22 H11.6 V34 H13 V40 H15 V46 H17 V100Z"
          fill="#5A6AA0"
        />
        <line x1="11" y1="22" x2="11" y2="12" stroke="#5A6AA0" strokeWidth="0.7" />
        {/* One World Trade Center. */}
        <path d="M84 100 L86 28 L94 28 L96 100Z" fill="#5F70A6" />
        <line x1="90" y1="28" x2="90" y2="12" stroke="#5F70A6" strokeWidth="0.7" />
        {detailed ? (
          <>
            {windows(
              [7, 10, 13],
              [50, 56, 62, 68, 74, 80, 86],
              "#F2D27A",
              (x, y) => (x + y) % 3 === 0,
            )}
            {windows(
              [86.5, 89.3, 92.1],
              [36, 44, 52, 60, 68, 76, 84],
              "#F2D27A",
              (x, y) => Math.round(x + y) % 4 === 0,
            )}
          </>
        ) : null}
      </>
    ),
  },

  san_francisco: {
    label: "San Francisco",
    sky: ["#F2A98A", "#FBE2C2"],
    draw: (detailed) => (
      <>
        <circle cx="50" cy="26" r="9" fill="#FCE7B7" />
        {/* Hills and the bay. */}
        <path d="M0 78 Q14 70 28 76 Q50 84 72 76 Q86 70 100 76 V100 H0Z" fill="#7A8F7E" />
        {/* The Golden Gate: main cables, deck, then the two towers. */}
        <g fill="none" stroke="#C4513D">
          <path d="M-6 50 Q9 22 9 22 Q50 66 91 22 Q91 22 106 50" strokeWidth="0.9" />
          <line x1="-2" y1="66" x2="102" y2="66" strokeWidth="1.6" />
          {detailed
            ? [16, 22, 28, 72, 78, 84].map((x) => (
                <line
                  key={x}
                  x1={x}
                  y1={x < 50 ? 22 + (x - 9) * 0.9 : 22 + (91 - x) * 0.9}
                  x2={x}
                  y2="66"
                  strokeWidth="0.3"
                />
              ))
            : null}
        </g>
        {[9, 91].map((x) => (
          <g key={x} fill="#C4513D">
            <rect x={x - 3.5} y="20" width="1.8" height="80" />
            <rect x={x + 1.7} y="20" width="1.8" height="80" />
            <rect x={x - 3.5} y="24" width="7" height="1.4" />
            <rect x={x - 3.5} y="36" width="7" height="1.4" />
            <rect x={x - 3.5} y="48" width="7" height="1.4" />
          </g>
        ))}
        {/* Fog rolling in. */}
        <path
          d="M-4 84 Q12 78 26 84 Q44 90 60 84 Q78 78 104 85 V100 H-4Z"
          fill="#FFFFFF"
          opacity="0.45"
        />
      </>
    ),
  },

  berlin: {
    label: "Berlin",
    sky: ["#6C5BA0", "#EBA8A0"],
    draw: (detailed) => (
      <>
        <path d="M0 100 V66 H10 V60 H24 V100Z M76 100 V62 H86 V100Z" fill="#7E6E9E" />
        {/* The Brandenburg Gate. */}
        <g fill="#B79A86">
          <rect x="0" y="62" width="22" height="3.4" />
          <path d="M8 62 L11 57 L14 62Z" />
          {detailed ? <rect x="10" y="55.6" width="2" height="2" /> : null}
          {[1, 5, 9, 13, 17].map((x) => (
            <rect key={x} x={x} y="65.4" width="2" height="34.6" />
          ))}
        </g>
        {/* The Fernsehturm. */}
        <g fill="#5E5577">
          <path d="M86 100 L88.6 42 H91.4 L94 100Z" />
          <circle cx="90" cy="38" r="5.4" />
          <rect x="89.3" y="18" width="1.4" height="16" />
        </g>
        {detailed ? (
          <>
            <ellipse cx="90" cy="38.6" rx="5.4" ry="0.9" fill="#8A80A6" />
            {[20, 24, 28].map((y) => (
              <rect key={y} x="89.3" y={y} width="1.4" height="1.6" fill="#E4685A" />
            ))}
          </>
        ) : null}
      </>
    ),
  },

  paris: {
    label: "Paris",
    sky: ["#F1B9C8", "#FCEAD8"],
    draw: (detailed) => (
      <>
        {/* Rooftops, with their mansards. */}
        <path
          d="M0 100 V72 L3 68 H20 L23 72 V100Z M76 100 V70 L79 66 H96 L99 70 H100 V100Z"
          fill="#A9A3B8"
        />
        {/* The Eiffel Tower. */}
        <g fill="#6F5E66">
          <path d="M2 100 Q9 72 10 44 H12 Q13 72 20 100 H16 Q14 90 11 86 Q8 90 6 100Z" />
          <path d="M10 44 L10.6 22 H11.4 L12 44Z" />
          <rect x="7.2" y="68" width="7.6" height="1.6" />
          <rect x="9" y="50" width="4" height="1.2" />
          <rect x="10.7" y="14" width="0.6" height="8" />
        </g>
        {detailed ? (
          <path
            d="M5 98 L11 70 L17 98 M8 78 L14 78"
            stroke="#8E7C85"
            strokeWidth="0.3"
            fill="none"
          />
        ) : null}
        {/* The Arc de Triomphe. */}
        <path
          d="M82 100 V58 H98 V100 H93.5 V78 Q90 72 86.5 78 V100Z"
          fill="#C9B9A6"
          stroke="#A9977F"
          strokeWidth="0.5"
        />
        <rect x="81" y="56" width="18" height="3" fill="#B8A792" />
      </>
    ),
  },

  tokyo: {
    label: "Tokyo",
    sky: ["#2A1E4C", "#C55A86"],
    draw: (detailed) => (
      <>
        {/* Mount Fuji, far off. */}
        <path d="M-12 70 L16 30 Q19 27 22 30 L52 70Z" fill="#6B5B8E" />
        <path
          d="M11 37 L16 30 Q19 27 22 30 L27 37 Q23 35 21 38 Q18 35 15 38 Q13 35 11 37Z"
          fill="#F1EAF5"
        />
        <circle cx="72" cy="14" r="4.5" fill="#F9DDE6" />
        <path
          d="M0 100 V64 H8 V58 H16 V70 H22 V100Z M74 100 V66 H80 V56 H86 V100Z"
          fill="#3B2C5E"
        />
        {detailed ? (
          <>
            <rect x="2" y="68" width="4" height="1.6" fill="#FF7BB0" />
            <rect x="10" y="62" width="4" height="1.6" fill="#6FE0E8" />
            <rect x="76" y="70" width="3" height="1.6" fill="#FFD36E" />
          </>
        ) : null}
        {/* Tokyo Tower, in its red and white. */}
        <g fill="#E4513F">
          <path d="M84 100 Q88 70 89.2 34 H90.8 Q92 70 96 100 H93 Q91.5 90 90 88 Q88.5 90 87 100Z" />
          <rect x="89.5" y="14" width="1" height="20" />
        </g>
        <g fill="#F4EEE8">
          <rect x="85.6" y="74" width="8.8" height="2" />
          <rect x="88.2" y="50" width="3.6" height="1.6" />
          {detailed ? <rect x="89.5" y="24" width="1" height="3" /> : null}
        </g>
      </>
    ),
  },

  sydney: {
    label: "Sydney",
    sky: ["#79C3E6", "#DDF2F8"],
    draw: (detailed) => (
      <>
        {/* The Harbour Bridge's arch. */}
        <g fill="none" stroke="#5D6B78">
          <path d="M-8 72 Q12 26 32 72" strokeWidth="1.6" />
          {detailed ? <path d="M-6 72 Q12 34 30 72" strokeWidth="0.6" /> : null}
          <line x1="-4" y1="64" x2="30" y2="64" strokeWidth="1.4" />
          {detailed
            ? [2, 7, 12, 17, 22].map((x) => (
                <line
                  key={x}
                  x1={x}
                  y1="64"
                  x2={x}
                  y2={64 - 18 * (1 - ((x - 12) / 20) ** 2)}
                  strokeWidth="0.3"
                />
              ))
            : null}
        </g>
        <rect x="-2" y="56" width="4" height="16" fill="#C9B79C" />
        {/* The Opera House's sails. */}
        <g fill="#FBFAF4" stroke="#C9D3DA" strokeWidth="0.5">
          <path d="M74 72 Q78 52 90 46 Q86 58 88 72Z" />
          <path d="M84 72 Q88 54 100 50 Q96 60 98 72Z" />
          <path d="M92 72 Q96 60 104 58 V72Z" />
        </g>
        <rect x="72" y="72" width="30" height="3" fill="#D8C7A8" />
        {/* The harbour. */}
        <rect x="0" y="75" width="100" height="25" fill="#2F8DB5" />
        {detailed ? (
          <path d="M6 82 H16 M60 88 H74 M84 80 H94 M30 92 H40" stroke="#8ECFE6" strokeWidth="0.6" />
        ) : null}
      </>
    ),
  },

  dubai: {
    label: "Dubai",
    sky: ["#F0B970", "#FBE9C9"],
    draw: (detailed) => (
      <>
        <circle cx="48" cy="24" r="10" fill="#FCEFC9" opacity="0.9" />
        {/* The Burj Al Arab's sail. */}
        <path d="M4 82 L6 34 Q20 46 22 82Z" fill="#E9E3D8" stroke="#B8AE9E" strokeWidth="0.5" />
        <line x1="5.2" y1="82" x2="5.6" y2="30" stroke="#9C9284" strokeWidth="0.8" />
        {detailed ? (
          <path d="M7 40 Q14 50 18 70" stroke="#C9C0B2" strokeWidth="0.4" fill="none" />
        ) : null}
        {/* The Burj Khalifa, stepping up. */}
        <g fill="#8C8A93">
          <path d="M83 100 V76 H85 V60 H87 V44 H88.5 V30 H89.5 V18 H90.5 V30 H91.5 V44 H93 V60 H95 V76 H97 V100Z" />
          <rect x="89.75" y="4" width="0.5" height="14" />
        </g>
        {/* Dunes. */}
        <path d="M0 84 Q20 76 42 84 Q64 92 82 84 Q92 80 100 84 V100 H0Z" fill="#E1B577" />
        <path d="M0 92 Q26 86 50 92 Q76 98 100 92 V100 H0Z" fill="#D5A162" />
      </>
    ),
  },

  newcastle: {
    label: "Newcastle",
    sky: ["#8DA5BA", "#DFE5E8"],
    draw: (detailed) => (
      <>
        {/* Soft northern clouds. */}
        <g fill="#FFFFFF" opacity="0.7">
          <ellipse cx="34" cy="13" rx="11" ry="3.6" />
          <ellipse cx="41" cy="10.5" rx="6" ry="3" />
          <ellipse cx="88" cy="30" rx="9" ry="3" />
        </g>
        {/* Its hill, running down behind the head so it's on solid ground. */}
        <path d="M44 52 Q56 27 70 26 Q84 27 96 52Z" fill="#7F8F86" />
        {/* The Angel of the North, far off on its hill, wings out. */}
        <g fill="#9C5A3A">
          <path d="M58.6 11.6 L70 13.4 L81.4 11.6 L81.4 13.6 L70 15.8 L58.6 13.6Z" />
          <path d="M69 12.2 H71 L72.8 28 H67.2Z" />
          <circle cx="70" cy="11" r="1.4" />
        </g>
        {/* Rooftops on the quayside. */}
        <path d="M0 100 V72 H12 V68 H22 V100Z M78 100 V70 H90 V74 H100 V100Z" fill="#8A929B" />
        {/* The Tyne Bridge: its green arch, the deck running through it, a granite tower. */}
        <g fill="none" stroke="#3F7D5B">
          <path d="M-16 80 Q4 -8 24 80" strokeWidth="2" />
          {detailed ? <path d="M-13 80 Q4 4 21 80" strokeWidth="0.7" /> : null}
          {detailed
            ? [-6, -1, 4, 9, 14].map((x) => (
                <line
                  key={x}
                  x1={x}
                  y1="60"
                  x2={x}
                  y2={80 - 88 * ((x + 16) / 40) * (1 - (x + 16) / 40) + 1}
                  strokeWidth="0.3"
                />
              ))
            : null}
        </g>
        <rect x="-2" y="58.6" width="30" height="2.4" fill="#3F7D5B" />
        <rect x="20" y="52" width="6" height="28" fill="#C7BBA6" />
        <rect x="19.4" y="51" width="7.2" height="1.6" fill="#B1A48D" />
        {/* The Tyne. */}
        <rect x="0" y="80" width="100" height="20" fill="#4F7083" />
        {detailed ? (
          <path d="M6 86 H16 M62 90 H74 M82 84 H92" stroke="#8FB0C0" strokeWidth="0.6" />
        ) : null}
      </>
    ),
  },
};
