import { vi } from 'vitest';

// Keep the speaker illustration still in the test DOM.
vi.stubGlobal('matchMedia', () => ({ matches: true }));
