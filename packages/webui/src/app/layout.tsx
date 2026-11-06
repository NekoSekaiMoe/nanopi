import "@fontsource-variable/inter";
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "NanoPi",
	description: "Browser UI for nanopi.",
	manifest: "/manifest.webmanifest",
	// Same artwork as public/logo.png and the manifest icons.
	icons: {
		icon: [{ url: "/favicon.png", type: "image/png", sizes: "96x96" }],
		apple: [{ url: "/icon-192.png", sizes: "192x192" }],
	},
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	// Shrink the layout viewport when a soft keyboard opens. Chrome/Android
	// then reports the reduced height through `dvh`; iOS Safari does not, which
	// is why the head script below tracks visualViewport separately.
	interactiveWidget: "resizes-content",
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
		{ media: "(prefers-color-scheme: dark)", color: "#050506" },
	],
};

// The shell sizes itself from --app-height instead of the CSS `dvh` unit on
// touch devices. iOS Safari does not shrink `dvh` while the soft keyboard is
// open (even with interactiveWidget=resizes-content), so anything docked at
// the shell's bottom — the composer — ends up behind the keyboard. Tracking
// visualViewport.height also covers browser chrome show/hide and split view.
// Desktop keeps 100dvh: pinch-zoom shrinks its visual viewport without
// shrinking the layout viewport, which would leave a gap under the shell.
const heightScript = `
(function () {
  var vv = window.visualViewport;
  if (!vv || !window.matchMedia('(pointer: coarse)').matches) return;
  var apply = function () {
    document.documentElement.style.setProperty('--app-height', vv.height + 'px');
    document.documentElement.classList.toggle('keyboard-open', vv.height < window.innerHeight - 120);
  };
  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', apply);
})();
`;

const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('nanopi.theme');
    var dark = stored
      ? stored === 'dark' || (stored === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      : true;
    if (dark) document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: themeScript }} />
				<script dangerouslySetInnerHTML={{ __html: heightScript }} />
			</head>
			<body>{children}</body>
		</html>
	);
}
