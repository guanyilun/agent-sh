"""Turns a dataclass into the JSON Schema an agent must answer in, and the answer back into the dataclass."""
import dataclasses
import typing


def is_shape(tp):
    """True for a dataclass, or a list of something, given as `returns`."""
    return _is_dataclass(tp) or typing.get_origin(tp) is list


def schema(tp):
    """The JSON Schema for a type: dataclasses, lists, Optional, Literal, str, int, float, bool."""
    inner = _unwrap_optional(tp)
    if inner is not None:
        return schema(inner)
    if _is_dataclass(tp):
        hints = typing.get_type_hints(tp)
        fields = dataclasses.fields(tp)
        return {
            "type": "object",
            "properties": {f.name: schema(hints[f.name]) for f in fields},
            "required": [f.name for f in fields if _is_required(f, hints[f.name])],
        }
    origin = typing.get_origin(tp)
    if origin in (list, tuple, set):
        items = typing.get_args(tp)
        return {"type": "array", "items": schema(items[0])} if items else {"type": "array"}
    if origin is typing.Literal:
        return {"enum": list(typing.get_args(tp))}
    if tp in _SIMPLE:
        return {"type": _SIMPLE[tp]}
    return {}


def build(tp, value):
    """Rebuild an answer (dicts and lists from JSON) as the type that was asked for."""
    inner = _unwrap_optional(tp)
    if inner is not None:
        return None if value is None else build(inner, value)
    if _is_dataclass(tp) and isinstance(value, dict):
        hints = typing.get_type_hints(tp)
        return tp(**{f.name: build(hints[f.name], value[f.name]) for f in dataclasses.fields(tp) if f.name in value})
    if typing.get_origin(tp) is list and isinstance(value, list) and typing.get_args(tp):
        return [build(typing.get_args(tp)[0], item) for item in value]
    return value


def plain(value):
    """For json.dumps: a dataclass instance becomes a dict."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    return str(value)


_SIMPLE = {str: "string", int: "integer", float: "number", bool: "boolean", list: "array", dict: "object"}


def _is_dataclass(tp):
    return isinstance(tp, type) and dataclasses.is_dataclass(tp)


def _is_required(field, tp):
    has_default = field.default is not dataclasses.MISSING or field.default_factory is not dataclasses.MISSING
    return not has_default and _unwrap_optional(tp) is None


def _unwrap_optional(tp):
    """`Optional[X]` (or `X | None`) gives X; anything else gives None."""
    is_union = typing.get_origin(tp) is typing.Union or type(tp).__name__ == "UnionType"
    members = typing.get_args(tp) if is_union else ()
    others = [m for m in members if m is not type(None)]
    if len(others) == len(members):
        return None
    return others[0] if len(others) == 1 else typing.Union[tuple(others)]
