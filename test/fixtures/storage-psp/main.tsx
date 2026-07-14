import { Text, View } from "@pocketjs/framework/components";
import { mount } from "@pocketjs/framework/solid";
import { storage } from "@pocketjs/framework/storage";

const boots = Number(storage.getItem("boots") ?? "0") + 1;
storage.setItem("boots", String(boots));
if (!storage.flush()) throw new Error("storage fixture: flush failed");

mount(() => (
  <View class="w-full h-full bg-black items-center justify-center">
    <Text class="text-white text-base">Storage boot {boots}</Text>
  </View>
));
