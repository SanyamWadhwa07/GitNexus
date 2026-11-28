package com.acme.billing

class Ledger {
    fun round(cents: Int): Int = roundUp(cents)

    fun samples(): Int = sampleAmounts().size

    fun label(): String = toDollars()
}
