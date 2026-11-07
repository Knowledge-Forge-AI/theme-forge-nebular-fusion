import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { FixtureStudioHostBridge } from './host/studio-host-bridge';
import { MockThemeLabBridge } from './features/theme-lab/test/mock-bridge';
import { MockAppThemeBridge } from './features/application-theme/app-theme-bridge';
import './styles/studio.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App
  hostBridge={new FixtureStudioHostBridge()}
  themeLabBridge={new MockThemeLabBridge()}
  appThemeBridge={new MockAppThemeBridge()}
/></StrictMode>);
