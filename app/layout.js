import './globals.css';

export const metadata = {
  title: 'Cartes Super Regions',
  description: 'Create and publish super-region GeoJSON files'
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
