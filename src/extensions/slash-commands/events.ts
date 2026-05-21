/** Events slash-commands owns. */
declare module "../../core/event-bus.js" {
  interface BusEvents {
    "command:register": {
      name: string;
      description: string;
      handler: (args: string) => Promise<void> | void;
    };
    "command:unregister": { name: string };
    "command:execute": { name: string; args: string };
  }
}

export {};
