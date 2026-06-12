import { isArray, isBoolean, isNil, isNumber, isPlainObject, isString } from "lodash-es";
import type { A2uiClientAction, A2uiClientDataModel } from "@a2ui/web_core/v0_9";

type ScalarFieldValue = string | number | boolean | null;
type FieldValue = ScalarFieldValue | ScalarFieldValue[];
type A2uiSurfaceData = A2uiClientDataModel["surfaces"][string];
type A2uiSurfaceDataMap = A2uiClientDataModel["surfaces"];
interface FieldRecord {
  [key: string]: FieldInput;
}
type FieldInput =
  | FieldValue
  | FieldInput[]
  | FieldRecord
  | A2uiClientDataModel
  | A2uiSurfaceDataMap
  | A2uiSurfaceData
  | undefined;
type Field = [name: string, value: FieldValue];

export interface A2uiActionPayload {
  action: A2uiClientAction;
  /** Aggregated data model for surfaces with `sendDataModel: true`, if any. */
  dataModel: A2uiClientDataModel | undefined;
}

export function formatA2uiUserMessage(payload: A2uiActionPayload): string {
  const dataFields = extractA2uiDataFields(payload);
  if (dataFields.length > 0) {
    return formatFields(dataFields);
  }

  const contextFields = flattenFields(payload.action.context);
  if (contextFields.length > 0) {
    return formatFields(contextFields);
  }

  return payload.action.name.trim() ? `action: ${payload.action.name}` : "Submitted the form.";
}

function extractA2uiDataFields(payload: A2uiActionPayload): Field[] {
  const dataModel = payload.dataModel;
  const surfaces = dataModel?.surfaces;
  if (isRecord(surfaces)) {
    const surfaceEntries = Object.entries(surfaces).filter(([, value]) => value !== undefined);
    if (surfaceEntries.length === 1) {
      return flattenFields(surfaceEntries[0]?.[1]);
    }
    return surfaceEntries.flatMap(([surfaceId, value]) => flattenFields(value, surfaceId));
  }
  return flattenFields(dataModel);
}

function flattenFields(value: FieldInput, prefix = ""): Field[] {
  if (value === undefined) {
    return [];
  }
  if (isArray(value)) {
    if (isScalarArray(value)) {
      return prefix ? [[prefix, value]] : [];
    }
    return value.flatMap((item, index) => flattenFields(item, `${prefix}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      flattenFields(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return prefix && isScalarValue(value) ? [[prefix, value]] : [];
}

function formatFields(fields: Field[]): string {
  return fields.map(([name, value]) => `${name}: ${formatFieldValue(value)}`).join("\n");
}

function formatFieldValue(value: FieldValue): string {
  if (isArray(value)) {
    return value.map(formatFieldValue).join(", ");
  }
  if (isNil(value)) {
    return "";
  }
  if (isString(value)) {
    return value;
  }
  if (isNumber(value) || isBoolean(value)) {
    return String(value);
  }
  return "";
}

function isScalarArray(value: FieldInput[]): value is ScalarFieldValue[] {
  return value.every(isScalarValue);
}

function isScalarValue(value: FieldInput): value is ScalarFieldValue {
  return value === null || isString(value) || isNumber(value) || isBoolean(value);
}

function isRecord(value: FieldInput): value is FieldRecord {
  return isPlainObject(value);
}
