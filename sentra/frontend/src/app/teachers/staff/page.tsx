"use client";

/**
 * 先生画面（UI仕様書 6章）。「先生を読む」権限を持つ学年主任・教頭・校長だけに出る。
 * 担任の先生を開いても、その先生のクラスの生徒の記録はここからは見られない
 * （生徒の記録は Blesc の教員の画面 /educator のもの）。
 */

import { Suspense } from "react";
import { AccessGate } from "@/components/teachers/parts";
import { PeopleScreen } from "@/components/teachers/PeopleScreen";

export default function StaffPage() {
  return (
    <AccessGate need="teachers">
      <Suspense>
        <PeopleScreen />
      </Suspense>
    </AccessGate>
  );
}
