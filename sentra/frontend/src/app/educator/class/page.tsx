"use client";

/**
 * クラス画面（UI仕様書 5章）。「生徒を読む」権限を持つ人だけに出る。
 * 担任は自分のクラス、学年主任は学年、養護教諭・スクールカウンセラーは全生徒。
 */

import { Suspense } from "react";
import { AccessGate } from "@/components/teachers/parts";
import { PeopleScreen } from "@/components/teachers/PeopleScreen";

export default function ClassPage() {
  return (
    <AccessGate need="students">
      <Suspense>
        <PeopleScreen kind="student" />
      </Suspense>
    </AccessGate>
  );
}
