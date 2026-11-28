package com.acme.billing

private fun roundUp(cents: Int): Int = cents + 1

fun Int.toDollars(): String = "USD " + this / 100
