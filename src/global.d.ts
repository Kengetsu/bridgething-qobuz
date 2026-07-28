/// <reference types="vite/client" />

declare module "*.css" {
  const classes: { [key: string]: string };
  export default classes;
}

// Settings module specific type
declare module "@bridgething/client/settings" {
  export const settings: {
    config: {
      list: () => Promise<{ key: string; value: string }[]>;
      set: (key: string, value: string) => Promise<void>;
    };
    doc: {
      list: () => Promise<{ key: string; value: string }[]>;
      set: (key: string, value: string) => Promise<void>;
    };
    done: () => void;
  };
}
