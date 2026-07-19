# orbiterx-protocol

This crate defines the "types" for the protocol used by OrbiterX CLI, which includes both "internal types" for communication between `orbiterx-core` and `orbiterx-tui`, as well as "external types" used with `orbiterx app-server`.

This crate should have minimal dependencies.

Ideally, we should avoid "material business logic" in this crate, as we can always introduce `Ext`-style traits to add functionality to types in other crates.
