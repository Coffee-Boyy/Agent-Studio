from __future__ import annotations

import ast
from typing import Any


class ExpressionError(ValueError):
    pass


_ALLOWED_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod)
_ALLOWED_UNARYOPS = (ast.Not, ast.USub, ast.UAdd)
_ALLOWED_BOOLOPS = (ast.And, ast.Or)
_ALLOWED_CMPOPS = (
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.In,
    ast.NotIn,
    ast.Is,
    ast.IsNot,
)


def validate_expression(expr: str) -> None:
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise ExpressionError(str(exc)) from exc
    _validate_node(tree.body)


def evaluate_expression(expr: str, context: dict[str, Any]) -> bool:
    validate_expression(expr)
    tree = ast.parse(expr, mode="eval")
    value = _eval_node(tree.body, context)
    return bool(value)


def _validate_node(node: ast.AST) -> None:
    if isinstance(node, ast.Constant):
        return
    if isinstance(node, ast.Name):
        return
    if isinstance(node, ast.BoolOp):
        if not isinstance(node.op, _ALLOWED_BOOLOPS):
            raise ExpressionError("boolean operator not allowed")
        for value in node.values:
            _validate_node(value)
        return
    if isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, _ALLOWED_UNARYOPS):
            raise ExpressionError("unary operator not allowed")
        _validate_node(node.operand)
        return
    if isinstance(node, ast.BinOp):
        if not isinstance(node.op, _ALLOWED_BINOPS):
            raise ExpressionError("binary operator not allowed")
        _validate_node(node.left)
        _validate_node(node.right)
        return
    if isinstance(node, ast.Compare):
        for op in node.ops:
            if not isinstance(op, _ALLOWED_CMPOPS):
                raise ExpressionError("comparison operator not allowed")
        _validate_node(node.left)
        for comparator in node.comparators:
            _validate_node(comparator)
        return
    if isinstance(node, ast.Subscript):
        _validate_node(node.value)
        _validate_node(node.slice)
        return
    if isinstance(node, ast.Attribute):
        _validate_node(node.value)
        return
    if isinstance(node, ast.Dict):
        for key in node.keys:
            if key is not None:
                _validate_node(key)
        for value in node.values:
            _validate_node(value)
        return
    if isinstance(node, (ast.List, ast.Tuple)):
        for value in node.elts:
            _validate_node(value)
        return
    if isinstance(node, ast.Slice):
        if node.lower is not None:
            _validate_node(node.lower)
        if node.upper is not None:
            _validate_node(node.upper)
        if node.step is not None:
            _validate_node(node.step)
        return
    raise ExpressionError(f"expression not allowed: {type(node).__name__}")


def _eval_node(node: ast.AST, context: dict[str, Any]) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        return context.get(node.id)
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            return all(_eval_node(value, context) for value in node.values)
        if isinstance(node.op, ast.Or):
            return any(_eval_node(value, context) for value in node.values)
    if isinstance(node, ast.UnaryOp):
        value = _eval_node(node.operand, context)
        if isinstance(node.op, ast.Not):
            return not value
        if isinstance(node.op, ast.USub):
            return -value
        if isinstance(node.op, ast.UAdd):
            return +value
    if isinstance(node, ast.BinOp):
        left = _eval_node(node.left, context)
        right = _eval_node(node.right, context)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            return left / right
        if isinstance(node.op, ast.Mod):
            return left % right
    if isinstance(node, ast.Compare):
        left = _eval_node(node.left, context)
        for op, comparator in zip(node.ops, node.comparators):
            right = _eval_node(comparator, context)
            if isinstance(op, ast.Eq) and not (left == right):
                return False
            if isinstance(op, ast.NotEq) and not (left != right):
                return False
            if isinstance(op, ast.Lt) and not (left < right):
                return False
            if isinstance(op, ast.LtE) and not (left <= right):
                return False
            if isinstance(op, ast.Gt) and not (left > right):
                return False
            if isinstance(op, ast.GtE) and not (left >= right):
                return False
            if isinstance(op, ast.In) and not (left in right):
                return False
            if isinstance(op, ast.NotIn) and not (left not in right):
                return False
            if isinstance(op, ast.Is) and not (left is right):
                return False
            if isinstance(op, ast.IsNot) and not (left is not right):
                return False
            left = right
        return True
    if isinstance(node, ast.Subscript):
        target = _eval_node(node.value, context)
        key = _eval_node(node.slice, context)
        try:
            return target[key]
        except Exception:  # noqa: BLE001
            return None
    if isinstance(node, ast.Attribute):
        target = _eval_node(node.value, context)
        if isinstance(target, dict):
            return target.get(node.attr)
        return getattr(target, node.attr, None)
    if isinstance(node, ast.Dict):
        return {(_eval_node(k, context) if k is not None else None): _eval_node(v, context) for k, v in zip(node.keys, node.values)}
    if isinstance(node, ast.List):
        return [_eval_node(v, context) for v in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_eval_node(v, context) for v in node.elts)
    if isinstance(node, ast.Slice):
        lower = _eval_node(node.lower, context) if node.lower is not None else None
        upper = _eval_node(node.upper, context) if node.upper is not None else None
        step = _eval_node(node.step, context) if node.step is not None else None
        return slice(lower, upper, step)
    raise ExpressionError(f"expression not allowed: {type(node).__name__}")
