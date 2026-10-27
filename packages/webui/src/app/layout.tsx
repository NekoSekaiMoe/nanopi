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
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
		{ media: "(prefers-color-scheme: dark)", color: "#050506" },
	],
};

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
			</head>
			<body>{children}</body>
		</html>
	);
}
