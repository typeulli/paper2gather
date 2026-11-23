"use client";

import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialsOf, setLocalUser, USER_COLORS, useLocalUser } from "@/lib/user";

/** Avatar button that lets the user change the name/color shown to collaborators. */
export function UserDialog() {
  const user = useLocalUser();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName(user.name);
          setColor(user.color);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="내 프로필">
          <Avatar className="size-7">
            <AvatarFallback style={{ backgroundColor: user.color }} className="text-[11px] text-white">
              {initialsOf(user.name)}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>내 프로필</DialogTitle>
          <DialogDescription>공동 작업자에게 표시되는 이름과 커서 색상입니다.</DialogDescription>
        </DialogHeader>
        <form
          id="user-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setLocalUser({ name: name.trim().slice(0, 40), color });
            setOpen(false);
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="user-name">이름</Label>
            <Input id="user-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label>색상</Label>
            <div className="flex flex-wrap gap-2">
              {USER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => setColor(c)}
                  className="flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition hover:scale-110"
                  style={{ backgroundColor: c, boxShadow: c === color ? `0 0 0 2px ${c}` : undefined }}
                >
                  {c === color && <CheckIcon className="size-4 text-white" />}
                </button>
              ))}
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button type="submit" form="user-form" disabled={!name.trim()}>
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
