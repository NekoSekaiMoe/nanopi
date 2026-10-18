import "@fontsource-variable/inter";
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "NanoPi",
	description: "Browser UI for nanopi.",
	manifest: "/manifest.webmanifest",
	icons: {
		icon: "/favicon.png",
		apple: "/icon-192.png",
	},
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
		{ media: "(prefers-color-scheme: dark)", color: "#1f1f1f" },
	],
};

const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('nanopi.theme');
    var dark = stored === 'dark' || (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
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
