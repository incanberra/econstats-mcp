import {afterEach} from "bun:test";
import {resetAccessState} from "../src/core/access";
process.env.ECONSTATS_DISK_CACHE="false";
afterEach(resetAccessState);
